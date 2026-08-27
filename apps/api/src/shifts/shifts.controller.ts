import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { opsDay } from './ops-day';
import { ShiftsService, type Actor } from './shifts.service';

/** The signed-in person, as the JWT strategy leaves them on the request. */
type Req = { user?: { userId: string; email: string; role: string } };

function actorOf(req: Req): Actor {
  const u = req.user;
  return {
    userId: u?.userId ?? '',
    email: u?.email ?? '',
    role: u?.role ?? 'READ_ONLY',
  };
}

/**
 * The shift desk.
 *
 * Every route is behind the guard. A shift is a record of who was responsible
 * for what and when, so an unattributed action against it would defeat the
 * point of keeping it.
 */
@ApiTags('shifts')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('shifts')
export class ShiftsController {
  constructor(private readonly shifts: ShiftsService) {}

  /** The open shift, whether I have joined it, and who is on it. */
  @Get('active')
  active(@Req() req: Req) {
    return this.shifts.active(actorOf(req));
  }

  @Post('start')
  start(
    @Req() req: Req,
    @Body()
    body: {
      name?: string;
      takenOverFrom?: string;
      balances?: Record<string, number>;
      startNotes?: string;
    },
  ) {
    return this.shifts.start(actorOf(req), body ?? {});
  }

  /** Adds me to the shift already running. */
  @Post('join')
  join(@Req() req: Req) {
    return this.shifts.join(actorOf(req));
  }

  @Post('end')
  end(
    @Req() req: Req,
    @Body()
    body: {
      handoverTo?: string;
      notes?: string;
      kyc?: unknown;
      tickets?: unknown[];
      force?: boolean;
    },
  ) {
    return this.shifts.end(actorOf(req), body ?? {});
  }

  /** Recent shifts, newest first. */
  @Get('history')
  history(@Query('limit') limit?: string) {
    return this.shifts.history(Number(limit ?? 30) || 30);
  }

  /** A whole ops day as columns — the handover pivot. Defaults to today's. */
  @Get('day')
  day(@Query('day') day?: string) {
    return this.shifts.day(
      day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : opsDay(new Date()),
    );
  }

  /** Everyone who can be assigned a task or handed the shift. */
  @Get('team')
  team() {
    return this.shifts.team();
  }

  // ── task library ──────────────────────────────────────────────────────
  // Readable by anyone signed in (the desk works from it); writable only by a
  // manager, enforced in the service so the rule lives with the data.

  @Get('library')
  library(@Query('activeOnly') activeOnly?: string) {
    return this.shifts.library(activeOnly === 'true');
  }

  @Post('library')
  saveTemplate(
    @Req() req: Req,
    @Body()
    body: {
      id?: string;
      title?: string;
      howTo?: string;
      category?: string;
      appliesTo?: string;
      priority?: string;
      active?: boolean;
      position?: number;
    },
  ) {
    return this.shifts.saveTemplate(actorOf(req), body ?? {});
  }

  @Delete('library/:id')
  deleteTemplate(@Req() req: Req, @Param('id') id: string) {
    return this.shifts.deleteTemplate(actorOf(req), id);
  }

  // ── tasks on the open shift ───────────────────────────────────────────

  @Post('tasks')
  addTask(
    @Req() req: Req,
    @Body()
    body: {
      title?: string;
      howTo?: string;
      category?: string;
      priority?: string;
      assigneeId?: string;
    },
  ) {
    return this.shifts.addTask(actorOf(req), body ?? {});
  }

  @Patch('tasks/:id')
  updateTask(
    @Req() req: Req,
    @Param('id') id: string,
    @Body()
    body: {
      status?: string;
      assigneeId?: string | null;
      notes?: string;
      priority?: string;
    },
  ) {
    return this.shifts.updateTask(actorOf(req), id, body ?? {});
  }

  /** Sends (or re-sends) a closed shift's handover to the team. */
  @Post(':id/send')
  send(@Param('id') id: string) {
    return this.shifts.sendHandover(id);
  }

  /**
   * The handover as it will look in an inbox — readable without one.
   *
   * Returned as a JSON string rather than served as text/html: this is
   * untrusted content built from notes people typed, and handing the browser a
   * page to render at an API origin is how a note becomes script. The
   * dashboard renders it inside a sandboxed frame instead.
   */
  @Get(':id/handover')
  handover(@Param('id') id: string) {
    return this.shifts.handoverHtml(id);
  }

  /**
   * One shift's handover report. Last, so `active`, `history`, `day`, `team`
   * and `library` are matched as themselves rather than as a shift id.
   */
  @Get(':id')
  report(@Param('id') id: string) {
    return this.shifts.report(id);
  }
}
