import {
  ConflictException,
  HttpException,
  InternalServerErrorException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';

/**
 * Turns a database failure into something the person who hit it can act on.
 *
 * Nest answers an unhandled throw with `{"statusCode":500,"message":"Internal
 * server error"}`. On screen that becomes "ApiError: Internal server error",
 * which is indistinguishable between a bug, a dropped connection, and the one
 * cause that is actually common here: the API deployed with a migration that has
 * not been applied yet, so a column the code writes does not exist. That has a
 * precise remedy, and saying it is the difference between a two-minute fix and
 * an afternoon.
 *
 * The raw error is logged in full; only the useful sentence is returned. The
 * message names schema objects (a column, a table) — never a value, so nothing
 * a customer typed can be reflected back out through an error.
 */
export function dbError(e: unknown, doing: string): HttpException {
  const log = new Logger('Database');
  log.error(`${doing} failed: ${describe(e)}`);

  // Already an HTTP error (a validation refusal from the caller) — let it pass.
  if (e instanceof HttpException) return e;

  // Prisma buries the driver's own words two levels down, under
  // meta.driverAdapterError.cause — and that is the only place the offending
  // column is actually named. Reading just `.cause` yields nothing useful, which
  // is how a precise Postgres error ("column X does not exist") reaches the
  // screen as "Internal server error".
  const err = e as {
    code?: string;
    cause?: Record<string, unknown>;
    meta?: { driverAdapterError?: { cause?: Record<string, unknown> } };
  };
  const cause = err?.meta?.driverAdapterError?.cause ?? err?.cause ?? {};
  const original = String(cause.originalCode ?? '');
  const kind = String(cause.kind ?? '');
  const detail = String(cause.originalMessage ?? '');
  const code = String(err?.code ?? '');

  // 42703 undefined_column, 42P01 undefined_table — the schema is behind the
  // code. Prisma reports these as P2022/P2021 in its own numbering.
  if (
    original === '42703' || original === '42P01' ||
    kind === 'ColumnNotFound' || kind === 'TableNotFound' ||
    code === 'P2022' || code === 'P2021'
  ) {
    return new ServiceUnavailableException(
      `The database is behind this build of the API — ${detail || 'a column or table the code writes does not exist'}. ` +
        'Apply the pending migrations (npx prisma migrate deploy from apps/api) and try again. ' +
        'No data was written.',
    );
  }

  if (code === 'P2002') {
    const target = (e as { meta?: { target?: unknown } })?.meta?.target;
    return new ConflictException(
      `That already exists${target ? ` (${String(target)})` : ''}.`,
    );
  }

  if (code === 'P2025') {
    return new ConflictException('The record was changed or removed by someone else.');
  }

  // 08006 connection failure, 53300 too many connections, and friends.
  if (original.startsWith('08') || original === '53300' || code === 'P1001') {
    return new ServiceUnavailableException(
      `The database could not be reached${detail ? ` — ${detail}` : ''}. Nothing was written.`,
    );
  }

  return new InternalServerErrorException(
    `${doing} failed: ${detail || describe(e)}`,
  );
}

function describe(e: unknown): string {
  const err = e as { message?: string; code?: string; name?: string };
  return err?.message || err?.code || err?.name || String(e);
}
