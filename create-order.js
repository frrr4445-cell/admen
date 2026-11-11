const { getAdmin, requireUser, method, assertSameOrigin, enforceRateLimit, sendError, paypalRequest } = require("./_lib/common");
const VAT_RATE=0.15, CURRENCY="USD", HOLD_MS=30*60*1000;
const moneyCents=n=>{n=Number(n);if(!Number.isFinite(n)||n<=0)throw Object.assign(new Error("سعر العرض غير صالح."),{status:409});return Math.round(n*100);};
module.exports=async function handler(req,res){
 try{
  method(req); assertSameOrigin(req); const user=await requireUser(req);
  await enforceRateLimit(req,user.uid,"create-order",5,10*60_000);
  const offerId=String(req.body?.offerId||""), firstName=String(req.body?.firstName||"").trim(), lastName=String(req.body?.lastName||"").trim();
  if(!/^[A-Za-z0-9_-]{1,128}$/.test(offerId)||! /^[A-Za-z][A-Za-z .'’-]{1,79}$/.test(firstName)||! /^[A-Za-z][A-Za-z .'’-]{1,79}$/.test(lastName))return res.status(400).json({error:"بيانات المسافر غير مكتملة أو غير صالحة. استخدم الاسم الإنجليزي كما يظهر في الجواز."});
  const {db,FieldValue,Timestamp}=getAdmin(), offerRef=db.collection("offers").doc(offerId), lockRef=db.collection("offerLocks").doc(offerId), paymentRef=db.collection("payments").doc();
  const prepared=await db.runTransaction(async tx=>{
   const [snap,lockSnap]=await Promise.all([tx.get(offerRef),tx.get(lockRef)]); if(!snap.exists)throw Object.assign(new Error("العرض غير موجود."),{status:404});
   const o=snap.data(),lock=lockSnap.exists?lockSnap.data():{},now=Date.now(),hold=lock.heldUntil?.toMillis?.()||0,expiry=o.expiresAt?.toMillis?.()||0;
   if(o.status!=="available"||expiry<=now)throw Object.assign(new Error("العرض لم يعد متاحاً أو انتهت صلاحيته."),{status:409});
   if(lock.userId!==user.uid||hold<=now)throw Object.assign(new Error("انتهى الحجز المؤقت. ارجع إلى صفحة الدفع وجدّد الحجز."),{status:409});
   const paymentLockUntil=lock.paymentLockUntil?.toMillis?.()||0;
   if(paymentLockUntil>now)throw Object.assign(new Error("هناك عملية دفع أخرى قيد التنفيذ لهذا العرض. لا تفتح أكثر من نافذة دفع."),{status:409});
   const subtotal=moneyCents(o.discountedPrice); if(subtotal>100_000_000)throw Object.assign(new Error("سعر العرض يتجاوز الحد المسموح."),{status:409}); const tax=Math.round(subtotal*VAT_RATE),total=subtotal+tax;
   const snapshot={provider:String(o.provider||o.name||"Travel Touch").slice(0,160),room:String(o.room||"").slice(0,160),type:String(o.type||"travel").slice(0,40),location:String(o.location||"").slice(0,160),discountedPrice:Number(o.discountedPrice),currency:CURRENCY};
   tx.update(lockRef,{paymentId:paymentRef.id,paymentLockUntil:Timestamp.fromMillis(now+HOLD_MS),heldUntil:Timestamp.fromMillis(now+HOLD_MS),expiresAt:Timestamp.fromMillis(now+HOLD_MS+24*60*60_000),updatedAt:FieldValue.serverTimestamp()});
   tx.create(paymentRef,{provider:"paypal",userId:user.uid,userEmail:String(user.email || "").slice(0,254),offerId,status:"creating",currency:CURRENCY,amountSubtotal:subtotal,amountTax:tax,amountTotal:total,passenger:{firstName,lastName},offerSnapshot:snapshot,createdAt:FieldValue.serverTimestamp(),updatedAt:FieldValue.serverTimestamp()});
   return {subtotal,tax,total,snapshot};
  });
  try{
   const base=(process.env.PUBLIC_APP_URL||"").replace(/\/+$/,"");
   if(!/^https:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(base))throw new Error("PUBLIC_APP_URL must be a valid HTTPS origin");
   const order=await paypalRequest("/v2/checkout/orders",{method:"POST",requestId:`tt-${paymentRef.id}`,body:{
    intent:"CAPTURE",purchase_units:[{reference_id:paymentRef.id,custom_id:offerId,description:`${prepared.snapshot.provider} — Travel Touch`.slice(0,127),amount:{currency_code:CURRENCY,value:(prepared.total/100).toFixed(2)}}],
    payment_source:{paypal:{experience_context:{brand_name:"Travel Touch",user_action:"PAY_NOW",shipping_preference:"NO_SHIPPING",return_url:`${base}/payment-success`,cancel_url:`${base}/checkout?id=${encodeURIComponent(offerId)}&payment_canceled=1`}}}
   }});
   const approval=(order.links||[]).find(x=>x.rel==="approve"||x.rel==="payer-action");
   if(!order.id||!approval?.href||!/^https:\/\/([a-z0-9-]+\.)*paypal\.com\//i.test(approval.href))throw new Error("PayPal approval URL missing");
   await paymentRef.update({status:"pending",paypalOrderId:order.id,paypalApprovalUrl:approval.href,updatedAt:FieldValue.serverTimestamp()});
   return res.status(200).json({approvalUrl:approval.href,orderId:order.id});
  }catch(e){
   await paymentRef.set({status:"creation_failed",errorCode:"paypal_order_error",updatedAt:FieldValue.serverTimestamp()},{merge:true});
   await db.runTransaction(async tx=>{const s=await tx.get(lockRef);if(s.exists&&s.data().userId===user.uid&&s.data().paymentId===paymentRef.id)tx.delete(lockRef);});
   throw e;
  }
 }catch(e){return sendError(res,e);}
};
