const { getAdmin, requireUser, method, assertSameOrigin, enforceRateLimit, sendError, paypalRequest } = require("./_lib/common");
async function finalize(orderId,expectedUid){
 const {db,FieldValue}=getAdmin();
 const q=await db.collection("payments").where("paypalOrderId","==",orderId).limit(1).get();
 if(q.empty)throw Object.assign(new Error("طلب الدفع غير موجود."),{status:404});
 const pdoc=q.docs[0],p=pdoc.data();
 if(expectedUid&&p.userId!==expectedUid)throw Object.assign(new Error("لا يمكنك تأكيد دفع مستخدم آخر."),{status:403});
 if(p.status==="paid"&&p.bookingId){
  try { const { sendBookingConfirmation } = require("./_lib/email"); await sendBookingConfirmation({ paymentId:pdoc.id, payment:p, bookingId:p.bookingId }); } catch {}
  return {status:"paid",bookingId:p.bookingId};
 }
 if(p.status==="refunded")return {status:"refunded",bookingId:null};
 if(["refund_required", "review_required", "refund_pending", "refunding", "refund_failed"].includes(p.status))return {status:p.status,bookingId:null};
 if(Number(p.amountSubtotal)+Number(p.amountTax)!==Number(p.amountTotal) || Number(p.amountTax)!==Math.round(Number(p.amountSubtotal)*0.15))throw Object.assign(new Error("سجل المبلغ يحتاج مراجعة قبل إتمام الدفع."),{status:409});
 let order=await paypalRequest(`/v2/checkout/orders/${encodeURIComponent(orderId)}`);
 if(order.status==="APPROVED")order=await paypalRequest(`/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`,{method:"POST",body:{},requestId:`tt-capture-${orderId}`});
 if(order.id!==orderId)throw Object.assign(new Error("معرّف طلب PayPal غير مطابق."),{status:409});
 const unit=order.purchase_units?.find(x=>x.reference_id===pdoc.id&&x.custom_id===p.offerId);
 if(!unit)throw Object.assign(new Error("بيانات طلب PayPal غير مطابقة لسجل الدفع."),{status:409});
 const cap=unit.payments?.captures?.[0];
 if(order.status!=="COMPLETED"||cap?.status!=="COMPLETED"){
  const status=cap?.status==="PENDING"?"processing":"failed";
  await pdoc.ref.set({status,updatedAt:FieldValue.serverTimestamp()},{merge:true});return {status,bookingId:null};
 }
 if(cap.amount?.currency_code!==p.currency||Math.round(Number(cap.amount?.value)*100)!==Number(p.amountTotal)){
  await pdoc.ref.set({status:"review_required",requiresAdminReview:true,paypalCaptureId:cap.id,updatedAt:FieldValue.serverTimestamp()},{merge:true});
  return {status:"review_required",bookingId:null};
 }
 const offerRef=db.collection("offers").doc(p.offerId),lockRef=db.collection("offerLocks").doc(p.offerId),bookingRef=db.collection("bookings").doc();
 const result=await db.runTransaction(async tx=>{
  const [ps,os,ls]=await Promise.all([tx.get(pdoc.ref),tx.get(offerRef),tx.get(lockRef)]);
  const current=ps.data();if(current.status==="paid"&&current.bookingId)return {status:"paid",bookingId:current.bookingId};
  const o=os.exists?os.data():null,lock=ls.exists?ls.data():{},hold=lock.heldUntil?.toMillis?.()||0,expiry=o?.expiresAt?.toMillis?.()||0;
  if(!o||o.status!=="available"||lock.userId!==current.userId||lock.paymentId!==pdoc.id||hold<=Date.now()||expiry<=Date.now()){
   tx.update(pdoc.ref,{status:"refund_required",paypalCaptureId:cap.id,refundReason:"offer_lock_unavailable",updatedAt:FieldValue.serverTimestamp()});
   if(ls.exists&&lock.paymentId===pdoc.id)tx.delete(lockRef);
   return {status:"refund_required",bookingId:null};
  }
  tx.create(bookingRef,{userId:current.userId,offerId:current.offerId,paymentId:pdoc.id,paypalOrderId:orderId,paypalCaptureId:cap.id,status:"confirmed",passenger:current.passenger,offerSnapshot:current.offerSnapshot,price:{subtotal:current.amountSubtotal/100,tax:current.amountTax/100,total:current.amountTotal/100,currency:current.currency},createdAt:FieldValue.serverTimestamp(),confirmedAt:FieldValue.serverTimestamp()});
  tx.update(offerRef,{status:"sold",soldAt:FieldValue.serverTimestamp(),updatedAt:FieldValue.serverTimestamp()});
  tx.delete(lockRef);
  tx.update(pdoc.ref,{status:"paid",bookingId:bookingRef.id,paypalCaptureId:cap.id,paidAt:FieldValue.serverTimestamp(),updatedAt:FieldValue.serverTimestamp()});
  return {status:"paid",bookingId:bookingRef.id};
 });
 if(result.status==="refund_required"){
  // Never issue an automatic refund on an inventory/lock conflict: flag for an authorised
  // operator to reconcile supplier inventory, PayPal fees and customer communication.
  await pdoc.ref.set({requiresAdminReview:true,reviewReason:"offer_lock_unavailable",updatedAt:FieldValue.serverTimestamp()},{merge:true});
  return {status:"refund_required",bookingId:null};
 }
 if (result.status === "paid" && result.bookingId) {
  try {
   const { sendBookingConfirmation } = require("./_lib/email");
   await sendBookingConfirmation({ paymentId: pdoc.id, payment: p, bookingId: result.bookingId });
  } catch (emailError) { console.error("Booking confirmation email unavailable:", emailError?.message || "unknown"); }
 }
 return result;
}
module.exports=async function handler(req,res){
 try{method(req);assertSameOrigin(req);const user=await requireUser(req);await enforceRateLimit(req,user.uid,"capture-order",8,60_000);const id=String(req.body?.orderId||"");if(id.length<8||id.length>80)return res.status(400).json({error:"معرّف طلب PayPal غير صالح."});return res.status(200).json(await finalize(id,user.uid));}
 catch(e){return sendError(res,e);}
};
module.exports.finalize=finalize;
