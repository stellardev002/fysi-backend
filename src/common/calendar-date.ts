import { registerDecorator, type ValidationOptions } from 'class-validator';

const SHAPE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** `Date` rolls 2026-02-30 over to March, so a real date must survive a round trip. */
export const isCalendarDate = (value: unknown): value is string => {
  if (typeof value !== 'string' || !SHAPE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value)
  );
};

/** A `YYYY-MM-DD` day that exists on the calendar. */
export const IsCalendarDate =
  (options?: ValidationOptions) => (target: object, propertyName: string) =>
    registerDecorator({
      name: 'isCalendarDate',
      target: target.constructor,
      propertyName,
      options: {
        message: `${propertyName} must be a date like 2026-11-01`,
        ...options,
      },
      validator: { validate: isCalendarDate },
    });
