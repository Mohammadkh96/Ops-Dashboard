import { Injectable } from '@nestjs/common';

import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/** Launders an arbitrary value into a Prisma JSON input type. */
function asJson(v: unknown): Prisma.InputJsonValue {
  // Prisma's JSON input type doesn't model `unknown`, so the cast is required.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
  return (v ?? {}) as Prisma.InputJsonValue;
}

// Persistence for the config-driven reconciliation feature: the PSP registry
// and saved run history. All methods degrade gracefully when the database is
// unavailable so the API never hard-fails.

export type PspConfigDto = {
  id: string;
  label: string;
  [key: string]: unknown;
};

export type ReconRunDto = {
  ranBy?: string;
  layer1Matched?: number;
  layer1Total?: number;
  layer2Matched?: number;
  layer2Total?: number;
  exceptionCount?: number;
  exposure?: number;
  summary: unknown;
};

@Injectable()
export class ReconService {
  constructor(private readonly prisma: PrismaService) {}

  private async safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await fn();
    } catch {
      return fallback;
    }
  }

  /** Returns the persisted PSP registry (empty array if none/unavailable). */
  async getPsps(): Promise<PspConfigDto[]> {
    return this.safe(async () => {
      const rows = await this.prisma.reconPspConfig.findMany({
        orderBy: { createdAt: 'asc' },
      });
      return rows.map((r) => r.config as PspConfigDto);
    }, []);
  }

  /** Replaces the entire registry with the supplied configs (bulk upsert + prune). */
  async replacePsps(psps: PspConfigDto[]): Promise<{ saved: number }> {
    return this.safe(
      async () => {
        const ids = psps.map((p) => p.id).filter(Boolean);
        await this.prisma.$transaction([
          this.prisma.reconPspConfig.deleteMany(
            ids.length ? { where: { id: { notIn: ids } } } : undefined,
          ),
          ...psps.map((p) =>
            this.prisma.reconPspConfig.upsert({
              where: { id: p.id },
              create: {
                id: p.id,
                label: String(p.label ?? p.id),
                config: asJson(p),
              },
              update: { label: String(p.label ?? p.id), config: asJson(p) },
            }),
          ),
        ]);
        return { saved: psps.length };
      },
      { saved: 0 },
    );
  }

  /** Saves a run summary and returns its id. */
  async saveRun(run: ReconRunDto): Promise<{ id: string | null }> {
    return this.safe<{ id: string | null }>(
      async () => {
        const created = await this.prisma.reconRun.create({
          data: {
            ranBy: run.ranBy ?? null,
            layer1Matched: run.layer1Matched ?? 0,
            layer1Total: run.layer1Total ?? 0,
            layer2Matched: run.layer2Matched ?? 0,
            layer2Total: run.layer2Total ?? 0,
            exceptionCount: run.exceptionCount ?? 0,
            exposure: run.exposure ?? 0,
            summary: asJson(run.summary),
          },
        });
        return { id: created.id };
      },
      { id: null },
    );
  }

  /** Recent run history (summary fields only — no heavy payload). */
  async listRuns(): Promise<unknown[]> {
    return this.safe(async () => {
      return this.prisma.reconRun.findMany({
        orderBy: { ranAt: 'desc' },
        take: 25,
        select: {
          id: true,
          ranAt: true,
          ranBy: true,
          layer1Matched: true,
          layer1Total: true,
          layer2Matched: true,
          layer2Total: true,
          exceptionCount: true,
          exposure: true,
        },
      });
    }, []);
  }

  /** Full run including the exceptions payload. */
  async getRun(id: string): Promise<unknown> {
    return this.safe(
      async () => this.prisma.reconRun.findUnique({ where: { id } }),
      null,
    );
  }
}
