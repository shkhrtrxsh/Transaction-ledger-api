export const MAX_MONEY = '9999999999999999.99';
export const MAX_MONEY_MINOR_UNITS = 999_999_999_999_999_999n;

export const AMOUNT_PATTERN = /^(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/;

export function amountToMinorUnits(amount: string): bigint {
  const [whole = '0', fraction = ''] = amount.split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
}

export function isPositiveAmount(amount: string): boolean {
  if (amount !== amount.trim() || !AMOUNT_PATTERN.test(amount)) {
    return false;
  }

  return amountToMinorUnits(amount) > 0n;
}

export function isWithinMoneyLimit(amount: string): boolean {
  if (amount !== amount.trim() || !AMOUNT_PATTERN.test(amount)) {
    return false;
  }

  return amountToMinorUnits(amount) <= MAX_MONEY_MINOR_UNITS;
}
