import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { AdminUnlockGuard } from '../auth/guards/admin-unlock.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ModulesService } from './modules.service';
import { parseRange } from '../common/range';

/** Who may change the shape of the desk, rather than work within it. */
const MANAGER_ROLES = ['ADMIN', 'OPERATIONS_MANAGER'];

@ApiTags('modules')
@Controller()
export class ModulesController {
  constructor(private readonly modules: ModulesService) {}

  /**
   * Real payments. `type=deposit|withdrawal|refund` narrows the list;
   * `range=1h|24h|7d|30d|90d` or `from`/`to` narrows the window.
   */
  @Get('transactions')
  transactions(
    @Query('type') type?: string,
    @Query('range') range?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.modules.transactions(type, parseRange({ range, from, to }));
  }

  /**
   * The available columns and their grouping.
   *
   * Declared before the :id route: Nest matches in declaration order, so
   * "columns" would otherwise be read as a payment id.
   */
  @Get('transactions/columns')
  columns() {
    return this.modules.columns();
  }

  /** Everything stored about one payment, including its real state history. */
  @Get('transactions/:id')
  transaction(@Param('id') id: string) {
    return this.modules.transactionDetail(id);
  }

  /**
   * One client's whole history, by the customer reference on their payments.
   *
   * The page's date filter is deliberately NOT applied here — the client window
   * carries its own optional from/to (ISO instants), and with neither this is
   * everything we hold for them. See clientProfile.
   *
   * Behind the guard, unlike its neighbours: this is the one endpoint that
   * returns a named person's email, phone, KYC status and country alongside
   * their entire payment history, and it answers to any reference you care to
   * try. The dashboard already signs in before it can open a client, so the
   * guard costs nothing there.
   */
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get('clients/:reference')
  client(
    @Param('reference') reference: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.modules.clientProfile(reference, from, to);
  }

  /**
   * Settled deposits and withdrawals per client, for the table's columns.
   *
   * POST because a page can carry hundreds of references and a query string is
   * the wrong place for them; it reads, it writes nothing. Behind the same guard
   * as the client profile — it reports what named people have funded.
   */
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Post('clients/totals')
  clientTotals(@Body() body: { refs?: string[] }) {
    return this.modules.clientTotals(
      Array.isArray(body?.refs) ? body.refs : [],
    );
  }

  /**
   * Volume and outcome for a period — the payments overview.
   *
   * Takes its own from/to (ISO instants) rather than the shared range: the
   * overview is read against a period somebody names, which moves independently
   * of the table underneath it.
   */
  @Get('payments/success-rate')
  successRate(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('shop') shop?: string,
  ) {
    return this.modules.successRate(from, to, shop);
  }

  /**
   * Where payments stop, per provider — the funnel.
   *
   * Behind the guard, unlike its neighbours: it reports each provider's
   * approval rate and how it loses payments side by side with the others,
   * which is commercially sensitive in a way a volume total is not.
   */
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get('payments/funnel')
  funnel(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('shop') shop?: string,
  ) {
    return this.modules.funnel(from, to, shop);
  }

  /**
   * What happens after a decline — recovery measured on our own history.
   *
   * Guarded with the funnel and for the same reason: it reports which of a
   * provider's decline codes come back and which never do.
   */
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get('payments/recovery')
  recovery(@Query('from') from?: string, @Query('to') to?: string) {
    return this.modules.recovery(from, to);
  }

  /** Headline figures for the payment pages, same filters. */
  @Get('payments/stats')
  paymentStats(
    @Query('type') type?: string,
    @Query('range') range?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.modules.paymentStats(type, parseRange({ range, from, to }));
  }

  @Get('gateways')
  gateways(
    @Query('range') range?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.modules.gateways(parseRange({ range, from, to }));
  }

  @Get('compliance/kyc')
  kyc() {
    return this.modules.kycCases();
  }

  /**
   * Open incidents: conditions the payment data is reporting right now, plus
   * the ones somebody has declared. No invented rows — see ModulesService.
   */
  @Get('incidents')
  incidents() {
    return this.modules.incidents();
  }

  /** Declares one. `signature` declares a live detection, evidence and all. */
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Post('incidents')
  declareIncident(
    @Body()
    body: {
      title?: string;
      severity?: string;
      impact?: string;
      signature?: string;
      categories?: string[];
    },
    @Req() req: { user?: { email?: string } },
  ) {
    return this.modules.declareIncident({ ...body, by: req.user?.email });
  }

  // ── incident categories ───────────────────────────────────────────────
  //
  // Readable by anyone signed in, because everybody needs to filter by them.
  // Adding one takes an account that can act — an agent naming a new kind of
  // problem is the point of the feature, so it is deliberately not a
  // manager-only privilege. Retiring one IS manager-only: it changes the list
  // everybody else works from.

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get('incident-categories')
  incidentCategories(@Query('includeRetired') includeRetired?: string) {
    return this.modules.incidentCategories(includeRetired === 'true');
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Post('incident-categories')
  createIncidentCategory(
    @Body() body: { name?: string },
    @Req() req: { user?: { email?: string; role?: string } },
  ) {
    if (req.user?.role === 'READ_ONLY') {
      throw new ForbiddenException(
        'A read-only account cannot add categories. Ask a manager to change your role.',
      );
    }
    return this.modules.createIncidentCategory({
      name: body?.name,
      by: req.user?.email,
    });
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Patch('incident-categories/:id')
  setCategoryActive(
    @Param('id') id: string,
    @Body() body: { active?: boolean },
    @Req() req: { user?: { role?: string } },
  ) {
    if (!MANAGER_ROLES.includes(req.user?.role ?? '')) {
      throw new ForbiddenException(
        'Only a manager can retire or restore a category — it changes the list everybody else files against.',
      );
    }
    return this.modules.setIncidentCategoryActive(id, body?.active !== false);
  }

  /** Re-tags an incident. The list sent is the list it ends up with. */
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Put('incidents/:id/categories')
  tagIncident(
    @Param('id') id: string,
    @Body() body: { categories?: string[] },
    @Req() req: { user?: { email?: string; role?: string } },
  ) {
    if (req.user?.role === 'READ_ONLY') {
      throw new ForbiddenException(
        'A read-only account cannot re-tag incidents.',
      );
    }
    return this.modules.tagIncident(
      id,
      body?.categories ?? [],
      req.user?.email,
    );
  }

  /** Moves one on — status, root cause, resolution, or just a note. */
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Patch('incidents/:id')
  updateIncident(
    @Param('id') id: string,
    @Body()
    body: {
      status?: string;
      rootCause?: string;
      resolution?: string;
      note?: string;
    },
    @Req() req: { user?: { email?: string } },
  ) {
    return this.modules.updateIncident(id, { ...body, by: req.user?.email });
  }

  @Get('operations')
  operations() {
    return this.modules.operations();
  }

  @Get('reports')
  reports() {
    return this.modules.reports();
  }

  // ── the Admin tab ─────────────────────────────────────────────────────
  //
  // This answered to ANYBODY. No sign-in, no role, no guard: a GET to
  // /api/admin/audit-logs returned the whole trail. It was reached only from an
  // admin screen, which is not a control — it is a habit of the one client that
  // happens to exist.
  //
  // Now behind BOTH: signed in as somebody, and the Admin tab unlocked. The
  // second is the one that matters here — being signed in on a machine somebody
  // walked away from is the ordinary way an operations dashboard gets misused.
  //
  // The account list that used to sit beside this is gone: it invented ids
  // (u-1, u-2…), so nothing on the screen could address a real account, and it
  // has been replaced by /api/admin/accounts in AdminController — which can
  // also write.
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, AdminUnlockGuard)
  @Get('admin/audit-logs')
  auditLogs() {
    return this.modules.auditLog();
  }
  // (all handlers return promises where DB-backed; Nest awaits them.)
}
