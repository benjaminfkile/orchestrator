import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";

import adoDiscoveryRouter from "./routers/adoDiscoveryRouter";
import anthropicRouter from "./routers/anthropicRouter";
import capabilitiesRouter from "./routers/capabilitiesRouter";
import agentBriefingRouter from "./routers/agentBriefingRouter";
import changesRouter from "./routers/changesRouter";
import configRouter from "./routers/configRouter";
import dispatchesRouter from "./routers/dispatchesRouter";
import eventsRouter from "./routers/eventsRouter";
import healthRouter from "./routers/healthRouter";
import modulesRouter from "./routers/modulesRouter";
import notificationsRouter from "./routers/notificationsRouter";
import notifiersRouter from "./routers/notifiersRouter";
import playbooksRouter from "./routers/playbooksRouter";
import rulesRouter from "./routers/rulesRouter";
import runnersRouter from "./routers/runnersRouter";
import runsRouter from "./routers/runsRouter";
import secretsRouter from "./routers/secretsRouter";
import settingsRouter from "./routers/settingsRouter";
import snippetsRouter from "./routers/snippetsRouter";
import wisperRouter from "./routers/wisperRouter";
import { publish } from "./services/changeBus";

const app = express();

app.use(express.json());

/**
 * Publish `resource` on the change bus after any successful mutating request to
 * a config router, so a live SPA refetches that resource. Fires on `finish`
 * (response fully sent, i.e. after the write committed) and only for a 2xx
 * non-GET response; the publish itself is fire-and-forget and never affects the
 * request. Read requests and error responses publish nothing.
 */
function publishOnWrite(resource: string): express.RequestHandler {
  return (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.on("finish", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            publish(resource);
          } catch {
            // Fire-and-forget: a publish must never surface on the write path.
          }
        }
      });
    }
    next();
  };
}

app.use("/api/health", healthRouter);
app.use("/api/events", publishOnWrite("events"), eventsRouter);
app.use("/api/rules", publishOnWrite("rules"), rulesRouter);
app.use("/api/notifiers", publishOnWrite("notifiers"), notifiersRouter);
app.use("/api/notifications", notificationsRouter);
app.use("/api/playbooks", publishOnWrite("playbooks"), playbooksRouter);
app.use("/api/runners", runnersRouter);
app.use("/api/capabilities", capabilitiesRouter);
app.use("/api/dispatches", dispatchesRouter);
app.use("/api/runs", runsRouter);
app.use("/api/settings", publishOnWrite("settings"), settingsRouter);
app.use("/api/snippets", publishOnWrite("snippets"), snippetsRouter);
app.use("/api/modules/ado", adoDiscoveryRouter);
app.use("/api/modules", modulesRouter);
app.use("/api/secrets", publishOnWrite("secrets"), secretsRouter);
app.use("/api/anthropic", anthropicRouter);
app.use("/api/wisper", wisperRouter);
app.use("/api/agent-briefing", agentBriefingRouter);
app.use("/api/changes", changesRouter);
app.use("/api/config", configRouter);

/**
 * Uniform error responder. Renders every error as `{error}`: a status carried on
 * the error (e.g. body-parser's 400 for malformed JSON) is preserved, and any
 * unexpected error becomes an opaque 500 rather than leaking a stack.
 */
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const status =
    typeof (err as { status?: unknown }).status === "number"
      ? (err as { status: number }).status
      : 500;
  const message =
    status === 500
      ? "internal server error"
      : String((err as { message?: unknown }).message ?? "error");
  res.status(status).json({ error: message });
});

export default app;
