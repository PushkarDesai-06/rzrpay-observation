/**
 * Money is stored and computed exclusively in integer paise.
 *
 * No float ever touches an amount. Formatting to rupees happens only at the
 * display boundary, which is what keeps "money recovered" exactly equal to the
 * sum of the amounts that were actually captured.
 */

export type Paise = number;

export function rupeesToPaise(rupees: number): Paise {
  return Math.round(rupees * 100);
}

export function paiseToRupees(paise: Paise): number {
  return paise / 100;
}

export function formatINR(paise: Paise): string {
  // Derived figures (money per message, averages) arrive as ratios rather than
  // whole paise. Rounding here keeps a stray fraction from being rendered as a
  // second decimal point.
  const rounded = Math.round(paise);
  const negative = rounded < 0;
  const abs = Math.abs(rounded);
  const rupees = Math.floor(abs / 100);
  const fraction = abs % 100;
  const formatted = new Intl.NumberFormat("en-IN").format(rupees);
  const body = fraction === 0 ? formatted : `${formatted}.${String(fraction).padStart(2, "0")}`;
  return `${negative ? "-" : ""}₹${body}`;
}

export function assertPaise(value: number, label = "amount"): Paise {
  if (!Number.isInteger(value)) {
    throw new TypeError(`${label} must be an integer number of paise, received ${value}`);
  }
  if (value < 0) {
    throw new RangeError(`${label} must not be negative, received ${value}`);
  }
  return value;
}

export function sumPaise(values: readonly Paise[]): Paise {
  return values.reduce<Paise>((total, value) => total + value, 0);
}
