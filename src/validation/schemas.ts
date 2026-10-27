import { z } from 'zod';
import { AppError } from '../errors/app-error';
import {
  AMOUNT_PATTERN,
  isPositiveAmount,
  isWithinMoneyLimit,
} from '../domain/money';

const uuidSchema = z
  .uuid('must be a valid UUID')
  .transform((value) => value.toLowerCase());

const nameSchema = z
  .string('name must be a string')
  .trim()
  .min(1, 'name must not be empty')
  .max(200, 'name must be at most 200 characters');

const referenceIdSchema = z
  .string('reference_id must be a string')
  .trim()
  .min(1, 'reference_id must not be empty')
  .max(200, 'reference_id must be at most 200 characters');

const descriptionSchema = z
  .string('description must be a string')
  .max(1000, 'description must be at most 1000 characters');

const amountSchema = z
  .string('amount must be a decimal string')
  .superRefine((value, context) => {
    if (value !== value.trim() || !AMOUNT_PATTERN.test(value)) {
      context.addIssue({
        code: 'custom',
        message:
          'amount must be a positive decimal string with at most 2 decimal places and at most 16 integer digits',
      });
      return;
    }

    if (!isPositiveAmount(value)) {
      context.addIssue({
        code: 'custom',
        message: 'amount must be greater than zero',
      });
    }

    if (!isWithinMoneyLimit(value)) {
      context.addIssue({
        code: 'custom',
        message: 'amount exceeds the maximum supported value',
      });
    }
  });

export const accountParamsSchema = z.strictObject({
  accountId: uuidSchema,
});

export const createAccountBodySchema = z.strictObject({
  name: nameSchema,
});

export const createTransactionBodySchema = z.strictObject({
  type: z.enum(['credit', 'debit'], 'type must be either "credit" or "debit"'),
  amount: amountSchema,
  description: descriptionSchema.default(''),
  reference_id: referenceIdSchema.refine(
    (value) => !value.startsWith('transfer:'),
    'reference_id values beginning with "transfer:" are reserved',
  ),
});

export const createTransferBodySchema = z
  .strictObject({
    source_account_id: uuidSchema,
    destination_account_id: uuidSchema,
    amount: amountSchema,
    reference_id: referenceIdSchema,
    description: descriptionSchema.default(''),
  })
  .superRefine((value, context) => {
    if (value.source_account_id === value.destination_account_id) {
      context.addIssue({
        code: 'custom',
        path: ['destination_account_id'],
        message: 'source and destination accounts must be different',
      });
    }
  });

function positiveIntegerString(field: string, maximum?: number) {
  return z
    .string(`${field} must be a positive integer`)
    .regex(/^[1-9]\d*$/, `${field} must be a positive integer`)
    .transform((value) => Number(value))
    .refine(
      (value) => Number.isSafeInteger(value) && Number.isSafeInteger(value * 100),
      `${field} is too large`,
    )
    .refine(
      (value) => maximum === undefined || value <= maximum,
      `${field} must be at most ${maximum}`,
    );
}

export const transactionHistoryQuerySchema = z.object({
  type: z.enum(['credit', 'debit'], 'type must be either "credit" or "debit"').optional(),
  page: positiveIntegerString('page').optional(),
  limit: positiveIntegerString('limit', 100).optional(),
});

export type CreateAccountBody = z.output<typeof createAccountBodySchema>;
export type CreateTransactionBody = z.output<typeof createTransactionBodySchema>;
export type CreateTransferBody = z.output<typeof createTransferBodySchema>;
export type TransactionHistoryQuery = z.output<typeof transactionHistoryQuerySchema>;

export function parseOrThrow<TSchema extends z.ZodType>(
  schema: TSchema,
  input: unknown,
): z.output<TSchema> {
  const result = schema.safeParse(input);

  if (!result.success) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', {
      issues: result.error.issues.map((issue) => ({
        path: issue.path.length > 0 ? issue.path.map(String).join('.') : null,
        code: issue.code,
        message: issue.message,
      })),
    });
  }

  return result.data;
}
