const { method, sendError, paypalToken, paypalBase, fetchWithTimeout, getAdmin } = require("./_lib/common");
const captureHandler=require("./capture-order");
module.exports=async function handler(req,res){
 try{
  method(req);
  const id=process.env.PAYPAL_WEBHOOK_ID;
  if(!id)return res.status(503).send("Webhook is not configured");
  const token=await paypalToken(),event=req.body;
  const r=await fetchWithTimeout(`${paypalBase()}/v1/notifications/verify-webhook-signature`,{method:"POST",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:JSON.stringify({
   auth_algo:req.headers["paypal-auth-algo"],cert_url:req.headers["paypal-cert-url"],transmission_id:req.headers["paypal-transmission-id"],transmission_sig:req.headers["paypal-transmission-sig"],transmission_time:req.headers["paypal-transmission-time"],webhook_id:id,webhook_event:event
  })}, 10000);
  const v=await r.json().catch(()=>({}));
  if(!r.ok||v.verification_status!=="SUCCESS")return res.status(401).send("Invalid webhook signature");
  if(event?.event_type==="PAYMENT.CAPTURE.COMPLETED"){
   const orderId=event.resource?.supplementary_data?.related_ids?.order_id;
   if(orderId)await captureHandler.finalize(orderId,null);
  } else if(event?.event_type==="PAYMENT.CAPTURE.REFUNDED") {
   const parentLink=(event.resource?.links||[]).find(link=>link.rel==="up")?.href||"";
   const captureId=parentLink.match(/\/captures\/([^/?#]+)/i)?.[1]||event.resource?.supplementary_data?.related_ids?.capture_id;
   if(captureId && String(event.resource?.status||"").toUpperCase()==="COMPLETED") {
    const {db,FieldValue,Timestamp}=getAdmin();
    const paymentQuery=await db.collection("payments").where("paypalCaptureId","==",captureId).limit(1).get();
    if(!paymentQuery.empty) {
     const paymentDoc=paymentQuery.docs[0], payment=paymentDoc.data();
     const eventId=String(event.id||"").slice(0,120);
     const eventRef=eventId?db.collection("paypalWebhookEvents").doc(eventId):null;
     const totalRefunded=Number(event.resource?.seller_payable_breakdown?.total_refunded_amount?.value || event.resource?.amount?.value || 0);
     const fullyRefunded=Math.round(totalRefunded*100)>=Number(payment.amountTotal||0);
     const nextStatus=fullyRefunded?"refunded":"partially_refunded";
     await db.runTransaction(async tx=>{
      if(eventRef){const seen=await tx.get(eventRef);if(seen.exists)return;tx.create(eventRef,{eventType:event.event_type,createdAt:FieldValue.serverTimestamp(),expiresAt:Timestamp.fromMillis(Date.now()+90*24*60*60_000)});}
      tx.set(paymentDoc.ref,{status:nextStatus,paypalRefundId:event.resource.id||payment.paypalRefundId||null,refundStatus:"COMPLETED",refundedAt:fullyRefunded?FieldValue.serverTimestamp():null,updatedAt:FieldValue.serverTimestamp()},{merge:true});
      if(payment.bookingId)tx.set(db.collection("bookings").doc(payment.bookingId),{status:fullyRefunded?"refunded":"refund_review",refundedAt:fullyRefunded?FieldValue.serverTimestamp():null,updatedAt:FieldValue.serverTimestamp()},{merge:true});
      tx.set(db.collection("auditLogs").doc(),{action:"paypal_refund_webhook",paymentId:paymentDoc.id,bookingId:payment.bookingId||null,paypalRefundId:event.resource.id||null,status:nextStatus,createdAt:FieldValue.serverTimestamp()});
     });
    }
   }
  }
  return res.status(200).send("OK");
 }catch(e){return sendError(res,e);}
};
