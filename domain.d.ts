export type CurrencyCode = 'USD' | 'EUR' | 'GBP' | 'EGP' | string;
export type OfferStatus = 'available' | 'held' | 'sold' | 'expired' | 'inactive';
export type PaymentStatus = 'created' | 'approved' | 'paid' | 'failed' | 'refund_pending' | 'refunded' | 'review_required' | 'refund_required';
export interface Offer { id: string; title: string; destination?: string; price: number; currency?: CurrencyCode; status?: OfferStatus; expiresAtMs?: number; [key: string]: unknown }
export interface Booking { id: string; userId: string; offerId: string; status: 'pending' | 'paid' | 'cancelled' | 'refunded'; paymentId?: string; createdAt?: unknown }
export interface Payment { id: string; bookingId: string; amount: number; currency: CurrencyCode; status: PaymentStatus; provider: 'paypal' | string; providerOrderId?: string }
export interface ApiError { error: string; code?: string; requestId?: string }
export interface ApiSuccess<T> { data: T; requestId?: string }
