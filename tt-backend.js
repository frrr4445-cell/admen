import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { initializeAppCheck, ReCaptchaV3Provider, getToken } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app-check.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  updateProfile, deleteUser, signOut, GoogleAuthProvider, signInWithPopup, sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  getFirestore, collection, doc, getDoc, getDocs, addDoc, setDoc, updateDoc, deleteDoc,
  query, where, orderBy, limit, onSnapshot, runTransaction, serverTimestamp, Timestamp
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { getStorage, ref as storageRef, uploadBytes, getDownloadURL, deleteObject } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-storage.js";
import { firebaseConfig } from "./firebase-config.js";
import { TTError, normalizeError } from "./services/core/errors.js";
import { VAT_RATE, calculatePrice } from "./services/domain/pricing.js";
import { showToast, confirmDialog, promptDialog } from "./services/core/toast.js";
import { appStore } from "./services/state/store.js";
import { TTCache } from "./services/core/cache.js";
import { optimisticUpdate } from "./services/core/optimistic.js";
import "./services/core/transitions.js";

const configured = firebaseConfig?.apiKey && !String(firebaseConfig.apiKey).startsWith("REPLACE_")
  && firebaseConfig?.projectId && !String(firebaseConfig.projectId).startsWith("REPLACE_");
let app, auth, db, appCheck, storage;
if (configured) {
  app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = getFirestore(app);
  storage = getStorage(app);
  const appCheckSiteKey = String(firebaseConfig.appCheckSiteKey || "").trim();
  if (appCheckSiteKey && location.protocol === "https:") {
    try { appCheck = initializeAppCheck(app, { provider: new ReCaptchaV3Provider(appCheckSiteKey), isTokenAutoRefreshEnabled: true }); }
    catch (error) { console.warn("Firebase App Check could not initialize", error?.message || ""); }
  }
}

const requireConfig = () => {
  if (!configured) throw new TTError("config", "أكمل بيانات Firebase داخل firebase-config.js أولاً.");
};
const userNow = () => auth?.currentUser || null;
const mapOffer = (snap) => {
  const d = snap.data();
  return { id: snap.id, ...d, expiresAtMs: d.expiresAt?.toMillis?.() ?? Number(d.expiresAtMs || 0) };
};
const adminStatus = async (user) => {
  if (!user) return false;
  const s = await getDoc(doc(db, "admins", user.uid));
  return s.exists();
};
let authReady;
const ready = () => {
  requireConfig();
  if (!authReady) authReady = new Promise(resolve => {
    const stop = onAuthStateChanged(auth, async user => {
      stop();
      resolve(user);
    });
  });
  return authReady;
};
const waitForAuth = async () => { await ready(); return userNow(); };
const mustUser = async () => {
  const u = await waitForAuth();
  if (!u) throw new TTError("unauthenticated", "يجب تسجيل الدخول أولاً.");
  return u;
};
const mustAdmin = async () => {
  const u = await mustUser();
  if (!(await adminStatus(u))) throw new TTError("permission-denied", "هذه العملية متاحة للمشرف فقط.");
  return u;
};

export const TT = {
  TTError, VAT_RATE, calculatePrice, appStore, cache: TTCache, storeCache: TTCache, optimisticUpdate,
  notify(message, type = "info") { return showToast(message, type); },
  confirm(message, options = {}) { return confirmDialog(message, options); },
  prompt(message, value = "", options = {}) { return promptDialog(message, value, options); },
  normalizeError,
  async whenReady() {
    const user = await waitForAuth();
    return { user, isAdmin: await adminStatus(user) };
  },
  onUser(callback) {
    requireConfig();
    return onAuthStateChanged(auth, async user => {
      let isAdmin = false;
      try { isAdmin = await adminStatus(user); } catch {}
      appStore.setState({ user, isAdmin });
      callback(user, { isAdmin });
    });
  },
  async signIn(email, password) {
    requireConfig();
    const result = await signInWithEmailAndPassword(auth, email.trim(), password);
    await setDoc(doc(db, "users", result.user.uid), {
      displayName: result.user.displayName || "", email: result.user.email || "", updatedAt: serverTimestamp()
    }, { merge: true });
    return result.user;
  },
  async register({ email, password, displayName }) {
    requireConfig();
    const normalizedEmail = String(email || "").trim().toLowerCase();
    const normalizedName = String(displayName || "").trim();
    if (normalizedEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) throw new TTError("invalid-email", "أدخل بريداً إلكترونياً صحيحاً.");
    if (normalizedName.length < 2 || normalizedName.length > 100) throw new TTError("invalid-name", "أدخل اسماً بين حرفين و100 حرف.");
    if (typeof password !== "string" || password.length < 8 || password.length > 128) throw new TTError("weak-password", "كلمة المرور يجب أن تكون بين 8 و128 حرفاً.");
    const result = await createUserWithEmailAndPassword(auth, normalizedEmail, password);
    try {
      await updateProfile(result.user, { displayName: normalizedName });
      await setDoc(doc(db, "users", result.user.uid), { displayName: normalizedName, email: result.user.email || "", createdAt: serverTimestamp() });
      return result.user;
    } catch (error) {
      try { await deleteUser(result.user); } catch {}
      throw error;
    }
  },
  async signInGoogle() {
    requireConfig();
    const result = await signInWithPopup(auth, new GoogleAuthProvider());
    await setDoc(doc(db, "users", result.user.uid), {
      displayName: result.user.displayName || "", email: result.user.email || "", updatedAt: serverTimestamp()
    }, { merge: true });
    return result.user;
  },
  async resetPassword(email) {
    requireConfig();
    const value = String(email || "").trim().toLowerCase();
    if (value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new TTError("invalid-email", "أدخل بريدك الإلكتروني أولاً.");
    return sendPasswordResetEmail(auth, value);
  },
  async deleteMyAccount() {
    const result = await this.apiRequest("/api/delete-account", {}, 27000);
    await signOut(auth).catch(() => {});
    return result;
  },
  async signOut() {
    requireConfig();
    try { if ("serviceWorker" in navigator) { const regs = await navigator.serviceWorker.getRegistrations(); await Promise.all(regs.map(r => r.unregister())); } } catch {}
    try { const keys = await caches.keys(); await Promise.all(keys.map(k => caches.delete(k))); } catch {}
    return signOut(auth);
  },
  requireLogin() {
    const current = location.pathname.split("/").pop() + location.search;
    const safeNext = /^(index|checkout|profile|ticketWallet|dashboard|payment-success)\.html(?:\?|$)/.test(current) ? current : "profile.html";
    location.href = `login.html?next=${encodeURIComponent(safeNext)}`;
  },
  async getOffer(id) {
    requireConfig();
    const s = await getDoc(doc(db, "offers", id));
    if (!s.exists()) throw new TTError("missing", "العرض غير موجود.");
    return mapOffer(s);
  },
  watchAdminPayments(callback, onError = () => {}) {
    requireConfig();
    const q = query(collection(db, "payments"), orderBy("createdAt", "desc"), limit(100));
    return onSnapshot(q, snap => callback(snap.docs.map(d => ({ id: d.id, ...d.data() }))), onError);
  },
  watchAuditLogs(callback, onError = () => {}) {
    requireConfig();
    const q = query(collection(db, "auditLogs"), orderBy("createdAt", "desc"), limit(100));
    return onSnapshot(q, snap => callback(snap.docs.map(d => ({ id: d.id, ...d.data() }))), onError);
  },
  watchOffers(callback, onError = () => {}) {
    requireConfig();
    const now = Timestamp.fromDate(new Date());
    const q = query(collection(db, "offers"), where("status", "==", "available"), where("expiresAt", ">", now), orderBy("expiresAt"), limit(100));
    let latest = [];
    const unsubscribe = onSnapshot(q, s => { latest = s.docs.map(mapOffer); appStore.setState({ offers: latest }); callback(latest.filter(o => o.expiresAtMs > Date.now())); }, onError);
    const expiryTimer = setInterval(() => callback(latest.filter(o => o.expiresAtMs > Date.now())), 15000);
    return () => { clearInterval(expiryTimer); unsubscribe(); };
  },
  watchAllOffers(callback, onError = () => {}) {
    requireConfig();
    return onSnapshot(query(collection(db, "offers"), orderBy("createdAt", "desc"), limit(300)),
      s => { const offers = s.docs.map(mapOffer); appStore.setState({ offers }); callback(offers); }, onError);
  },
  async holdOffer(offerId) {
    return optimisticUpdate({
      apply: () => { const previous = appStore.getState().cart; appStore.setState({ cart: { offerId, status: "pending" } }); return previous; },
      request: async () => { const result = await this.apiRequest("/api/hold-offer", { offerId }); return { offer: await this.getOffer(offerId), heldUntilMs: Number(result.heldUntilMs) }; },
      commit: result => appStore.setState({ cart: { offerId, status: "held", heldUntilMs: result.heldUntilMs } }),
      rollback: previous => appStore.setState({ cart: previous })
    });
  },
  async releaseHold(offerId) {
    return optimisticUpdate({
      apply: () => { const previous = appStore.getState().cart; if (previous?.offerId === offerId) appStore.setState({ cart: null }); return previous; },
      request: () => this.apiRequest("/api/release-hold", { offerId }),
      rollback: previous => appStore.setState({ cart: previous })
    });
  },
  async apiRequest(path, payload, timeoutMs = 22000) {
    const user = await mustUser();
    const token = await user.getIdToken();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(Math.max(Number(timeoutMs) || 22000, 1000), 28000));
    let response;
    const headers = { "Content-Type": "application/json", "Authorization": `Bearer ${token}` };
    if (appCheck) {
      try { const check = await getToken(appCheck, false); if (check?.token) headers["X-Firebase-AppCheck"] = check.token; }
      catch (error) { console.warn("App Check token unavailable", error?.message || ""); }
    }
    try { response = await fetch(path, {
      method: "POST",
      headers,
      body: JSON.stringify(payload || {}), signal: controller.signal
    }); } catch (error) {
      if (error.name === "AbortError") throw new TTError("timeout", "انتهت مهلة الاتصال. تحقق من الاتصال وحاول مجدداً.");
      throw new TTError("network", "تعذر الاتصال بالخادم حالياً.");
    } finally { clearTimeout(timer); }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new TTError("api-error", data.error || "تعذر الاتصال بالخادم.");
    return data;
  },
  async loadChatHistory() {
    const user = await mustUser();
    const token = await user.getIdToken();
    const headers = { Authorization: `Bearer ${token}` };
    if (appCheck) { try { const check = await getToken(appCheck, false); if (check?.token) headers["X-Firebase-AppCheck"] = check.token; } catch {} }
    let response;
    try { response = await fetch("/api/chat-history", { headers, cache: "no-store" }); }
    catch { throw new TTError("network", "تعذر تحميل المحادثات السابقة حالياً."); }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new TTError("api-error", data.error || "تعذر تحميل المحادثات السابقة.");
    return Array.isArray(data.messages) ? data.messages : [];
  },
  async uploadOfferImage(file) {
    await mustAdmin();
    if (!(file instanceof File) || !/^image\/(jpeg|png|webp)$/i.test(file.type) || file.size > 8 * 1024 * 1024)
      throw new TTError("invalid-image", "اختر صورة JPG أو PNG أو WebP بحجم لا يتجاوز 8 ميجابايت.");
    if (!storage) throw new TTError("storage-unavailable", "خدمة تخزين الصور غير مهيأة.");
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 1200 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d", { alpha: false });
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height); bitmap.close();
    const blob = await new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("تعذر ضغط الصورة")), "image/webp", 0.82));
    if (blob.type !== "image/webp") throw new TTError("webp-unsupported", "المتصفح لا يدعم ضغط WebP. استخدم متصفحاً حديثاً أو ارفع رابط صورة جاهزاً.");
    if (blob.size > 1_500_000) throw new TTError("image-too-large", "الصورة الناتجة أكبر من الحد المسموح.");
    const path = `offer-images/${(await mustUser()).uid}/${crypto.randomUUID()}.webp`;
    const object = storageRef(storage, path);
    await uploadBytes(object, blob, { contentType: "image/webp", cacheControl: "public,max-age=31536000,immutable" });
    return getDownloadURL(object);
  },
  async askAI(message) {
    if (typeof message !== "string" || !message.trim() || message.length > 1000)
      throw new TTError("invalid-argument", "اكتب رسالة من 1 إلى 1000 حرف.");
    const result = await this.apiRequest("/api/chat", { message: message.trim() });
    return result.reply;
  },
  async scanPassport(imageBase64, legalConsent = false) {
    if (typeof imageBase64 !== "string" || !imageBase64.startsWith("data:image/"))
      throw new TTError("invalid-argument", "صورة جواز السفر غير صالحة.");
    if (legalConsent !== true) throw new TTError("consent-required", "يجب الموافقة على معالجة صورة الجواز أولاً.");
    return this.apiRequest("/api/scan-passport", { imageBase64, legalConsent: true });
  },
  // PayPal order creation and capture are handled by authenticated Vercel API routes.
  async purchase({ offerId, firstName, lastName }) {
    return optimisticUpdate({
      apply: () => { const previous = appStore.getState().cart; appStore.setState({ cart: { ...(previous || {}), offerId, status: "payment-pending" } }); return previous; },
      request: async () => {
        const result = await this.apiRequest("/api/create-order", { offerId, firstName, lastName });
        const url = result?.approvalUrl;
        if (!url || !/^https:\/\//i.test(url) || !/([a-z0-9-]+\.)*paypal\.com$/i.test(new URL(url).hostname))
          throw new TTError("payment-not-configured", "لم يُرجع PayPal رابط موافقة صالحاً.");
        appStore.setState({ cart: { offerId, status: "redirecting-to-payment" } });
        location.assign(url);
        return result;
      },
      rollback: previous => appStore.setState({ cart: previous })
    });
  },
  async getTicketQrToken(bookingId) {
    return (await this.apiRequest("/api/ticket-qr", { bookingId })).token;
  },
  async checkInTicket(token) {
    await mustAdmin();
    return this.apiRequest("/api/checkin-ticket", { token });
  },
  async capturePayPalOrder(orderId) {
    return this.apiRequest("/api/capture-order", { orderId }, 27000);
  },
  async createOffer(data, expiryDate) {
    await mustAdmin();
    if (!(expiryDate instanceof Date) || expiryDate <= new Date()) throw new TTError("invalid-argument", "تاريخ انتهاء العرض غير صحيح.");
    const price = Number(data.discountedPrice), original = Number(data.originalPrice);
    if (!data.provider?.trim() || !data.room?.trim() || !(price > 0) || !(original > price))
      throw new TTError("invalid-argument", "تحقق من اسم المزود والمقعد/الغرفة والأسعار.");
    const result = await this.apiRequest("/api/admin-offer", { action: "create", offer: {
      ...data, provider: data.provider.trim(), room: data.room.trim(),
      originalPrice: original, discountedPrice: price, expiresAtMs: expiryDate.getTime()
    }});
    return result.offerId;
  },
  async updateOffer(id, patch) {
    await mustAdmin();
    return optimisticUpdate({
      apply: () => { const previous = appStore.getState().offers; appStore.setState({ offers: previous.map(o => o.id === id ? { ...o, ...patch } : o) }); return previous; },
      request: () => this.apiRequest("/api/admin-offer", { offerId: id, patch }),
      rollback: previous => appStore.setState({ offers: previous })
    });
  },
  async deleteOffer(id) {
    await mustAdmin();
    const offerRef = doc(db, "offers", id), snapshot = await getDoc(offerRef);
    if (!snapshot.exists()) throw new TTError("missing", "العرض غير موجود.");
    const image = String(snapshot.data().image || "");
    return optimisticUpdate({
      apply: () => { const previous = appStore.getState().offers; appStore.setState({ offers: previous.filter(o => o.id !== id) }); return previous; },
      request: async () => {
        const result = await this.apiRequest("/api/admin-offer", { action: "delete", offerId: id });
        if (image.includes("firebasestorage.googleapis.com") || image.startsWith("gs://")) {
          try { await deleteObject(storageRef(storage, image)); } catch (error) { console.warn("Offer image cleanup deferred", error?.code || "storage-error"); }
        }
        return result;
      },
      rollback: previous => appStore.setState({ offers: previous })
    });
  },
  async markOfferSold(id) {
    await mustAdmin();
    return optimisticUpdate({
      apply: () => { const previous = appStore.getState().offers; appStore.setState({ offers: previous.map(o => o.id === id ? { ...o, status: "sold" } : o) }); return previous; },
      request: () => updateDoc(doc(db, "offers", id), { status: "sold", updatedAt: serverTimestamp() }),
      rollback: previous => appStore.setState({ offers: previous })
    });
  },
  async seedDemoOffers(hours = 6) {
    await mustAdmin();
    const demo = [
      ["فندق تجريبي - دبي", "غرفة ديلوكس", 180, 125, "hotel", "دبي، الإمارات", "asia"],
      ["رحلة تجريبية - القاهرة", "مقعد اقتصادي", 320, 245, "flight", "القاهرة، مصر", "africa"]
    ];
    const expiry = new Date(Date.now() + Math.min(Math.max(Number(hours), 1), 24) * 3600000);
    for (const [provider, room, originalPrice, discountedPrice, type, location, region] of demo)
      await this.createOffer({ provider, name: provider, room, originalPrice, discountedPrice, type, location, region, image: "", stars: 0, demo: true }, expiry);
    return demo.length;
  },
  watchAllTickets(callback, onError = () => {}) {
    requireConfig();
    const q = query(collection(db, "supportTickets"), orderBy("createdAt", "desc"), limit(100));
    return onSnapshot(q, s => callback(s.docs.map(d => ({ id: d.id, ...d.data() }))), onError);
  },
  watchAdminPayments(callback, onError = () => {}) {
    requireConfig();
    const q = query(collection(db, "payments"), where("status", "in", ["refund_required", "review_required", "refund_pending", "refund_failed", "refunding", "partially_refunded"]), orderBy("createdAt", "desc"), limit(100));
    return onSnapshot(q, s => callback(s.docs.map(d => ({ id: d.id, ...d.data() }))), onError);
  },
  watchAdminAuditLogs(callback, onError = () => {}) {
    requireConfig();
    const q = query(collection(db, "auditLogs"), orderBy("createdAt", "desc"), limit(50));
    return onSnapshot(q, s => callback(s.docs.map(d => ({ id: d.id, ...d.data() }))), onError);
  },
  async refundPayment(paymentId, reason = "admin_review") {
    await mustAdmin();
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(String(paymentId || ""))) throw new TTError("invalid-argument", "معرّف الدفع غير صالح.");
    return this.apiRequest("/api/admin-refund", { paymentId, reason });
  },
  async setTicketStatus(id, status) {
    await mustAdmin();
    if (!["open", "resolved"].includes(status)) throw new TTError("invalid-argument", "حالة التذكرة غير صالحة.");
    return updateDoc(doc(db, "supportTickets", id), { status, resolvedAt: status === "resolved" ? serverTimestamp() : null });
  },
  async getBooking(id) {
    const user = await mustUser();
    const s = await getDoc(doc(db, "bookings", id));
    if (!s.exists()) throw new TTError("missing", "التذكرة غير موجودة.");
    if (s.data().userId !== user.uid) throw new TTError("permission-denied", "لا يمكنك عرض تذكرة مستخدم آخر.");
    return { id: s.id, ...s.data() };
  },
  async listMyBookings() {
    const user = await mustUser();
    const q = query(collection(db, "bookings"), where("userId", "==", user.uid), orderBy("createdAt", "desc"), limit(50));
    const s = await getDocs(q);
    return s.docs.map(d => ({ id: d.id, ...d.data() }));
  },
  async createSupportTicket({ type, invoice, description }) {
    const user = await mustUser();
    if (!description?.trim() || description.length > 3000) throw new TTError("invalid-argument", "اكتب وصفاً بين 1 و3000 حرف.");
    const ref = doc(collection(db, "supportTickets"));
    await setDoc(ref, {
      ticketNo: ref.id.slice(-8).toUpperCase(), userId: user.uid, userEmail: user.email || "",
      type: type || "general", invoice: invoice || "", description: description.trim(),
      status: "open", createdAt: serverTimestamp()
    });
    return ref;
  },
  esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
  }
};
