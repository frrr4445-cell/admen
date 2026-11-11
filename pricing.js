/** Monetary calculations use integer minor units to avoid floating point drift. */
export const VAT_RATE = 0.15;
export function calculatePrice(subtotal, vatRate = VAT_RATE) {
  if (!Number.isFinite(subtotal) || subtotal < 0) throw new RangeError('subtotal must be a finite non-negative number');
  if (!Number.isFinite(vatRate) || vatRate < 0 || vatRate > 1) throw new RangeError('vatRate must be between 0 and 1');
  const subtotalMinor = Math.round(subtotal * 100);
  const vatMinor = Math.round(subtotalMinor * vatRate);
  return Object.freeze({ subtotal: subtotalMinor / 100, vat: vatMinor / 100, total: (subtotalMinor + vatMinor) / 100, currencyScale: 2 });
}
