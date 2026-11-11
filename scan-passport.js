const { getAdmin, requireUser, method, assertSameOrigin, enforceRateLimit, fetchWithTimeout, sendError } = require("./_lib/common");

module.exports = async function handler(req, res) {
  try {
    method(req); assertSameOrigin(req);
    const user = await requireUser(req);
    if (req.body?.legalConsent !== true) return res.status(400).json({ error: "يجب الموافقة على معالجة صورة الجواز قبل المسح." });
    await enforceRateLimit(req, user.uid, "passport-ocr", 3, 10 * 60_000);
    const imageBase64 = String(req.body?.imageBase64 || "");
    if (!/^data:image\/(jpeg|jpg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/i.test(imageBase64) || imageBase64.length > 4_000_000)
      return res.status(400).json({error:"صورة جواز السفر غير صالحة أو كبيرة جداً. استخدم صورة واضحة بحجم أقل من 3MB."});
    if (!process.env.OPENAI_API_KEY) return res.status(503).json({error:"خدمة قراءة الجواز غير مهيأة بعد."});
    const { db, FieldValue } = getAdmin();
    await db.collection("consents").add({ userId: user.uid, agreed: true, purpose: "passport_ocr_name_extraction", createdAt: FieldValue.serverTimestamp() });
    const response = await fetchWithTimeout("https://api.openai.com/v1/chat/completions", {
      method:"POST", headers:{Authorization:`Bearer ${process.env.OPENAI_API_KEY}`,"Content-Type":"application/json"},
      body:JSON.stringify({
        model:process.env.OPENAI_VISION_MODEL || process.env.OPENAI_MODEL || "gpt-4o-mini",
        response_format:{type:"json_object"}, max_tokens:120,
        messages:[{role:"user",content:[
          {type:"text",text:"Read the passport's visual inspection zone or printed English name. Extract only the passenger's given/first name and surname/last name exactly as written in English. Do not infer missing text. Return JSON only: {\"firstName\":\"...\",\"lastName\":\"...\"}. If uncertain, return empty strings."},
          {type:"image_url",image_url:{url:imageBase64,detail:"high"}}
        ]}]
      })
    }, 20000);
    const data=await response.json().catch(()=>({}));
    if(!response.ok){console.error("OpenAI passport OCR error",response.status);return res.status(502).json({error:"فشل تحليل صورة جواز السفر."});}
    let parsed;
    try{parsed=JSON.parse(data.choices?.[0]?.message?.content||"{}");}catch{return res.status(502).json({error:"لم نتمكن من قراءة بيانات الجواز بوضوح."});}
    const firstName=String(parsed.firstName||"").trim().slice(0,80), lastName=String(parsed.lastName||"").trim().slice(0,80);
    if(firstName.length<2||lastName.length<2 || !/^[A-Za-z][A-Za-z .'’-]{0,79}$/.test(firstName) || !/^[A-Za-z][A-Za-z .'’-]{0,79}$/.test(lastName))return res.status(422).json({error:"لم تظهر الأسماء الإنجليزية بوضوح. التقط صورة أوضح أو أدخل الاسم يدوياً."});
    return res.status(200).json({firstName,lastName});
  }catch(e){return sendError(res,e);}
};
