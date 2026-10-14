#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(join(here, "..", "package.json"), "utf8"),
) as { version: string; name: string };

// Distinctive UA so Apify run meta.userAgent marks MCP-originated runs.
const USER_AGENT = `mambalabs-mcp ${pkg.name}@${pkg.version}`;

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
};

// Drop undefined values so optional inputs are not sent to the actor.
function compact(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

// How long the actor run itself is allowed to take, in seconds. The suite's
// slowest measured run on 2026-09-22 was 152 s on a seven platform search, so
// 1800 s is roughly twelve times that: headroom for a slow day without letting a
// hung run bill indefinitely.
const ACTOR_RUN_TIMEOUT_SECS = 1800;

// How long this wrapper waits for that run, in milliseconds. The actor's own
// timeout plus two minutes, so the run's own TIMED-OUT status is what the
// caller sees rather than the wrapper giving up first and reporting nothing.
const WRAPPER_WAIT_MS = (ACTOR_RUN_TIMEOUT_SECS + 120) * 1000;
const POLL_INTERVAL_MS = 3000;

const TERMINAL = new Set(["SUCCEEDED", "FAILED", "TIMED-OUT", "ABORTED", "ABORTING"]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Shared caller. actorPath is the actor's immutable Apify actor ID (a stable key
// that survives Store renames). The /v2/acts/{id} endpoint accepts it directly,
// so a Store rename never breaks these calls.
//
// START AND POLL, NOT RUN-SYNC. Apify's synchronous endpoints carry a platform
// ceiling of 300 seconds on the HTTP wait itself and answer 408 past it whatever
// the timeout parameter says, so a long run reads as a timeout even though the
// actor goes on to finish. Starting the run, polling it to a terminal status and
// then reading the dataset is the only way to wait as long as the actor needs.
//
// The token is read here rather than at module load, so the tool registers
// unconditionally and a server started without APIFY_TOKEN still advertises its
// capabilities instead of reporting none.
async function runActor(
  actorPath: string,
  actorLabel: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const APIFY_TOKEN = process.env.APIFY_TOKEN;
  if (!APIFY_TOKEN) {
    return { isError: true, content: [{ type: "text", text: "APIFY_TOKEN is not set. Create a token at https://console.apify.com/account/integrations and set it as the APIFY_TOKEN environment variable." }] };
  }

  const headers = {
    Authorization: `Bearer ${APIFY_TOKEN}`,
    "Content-Type": "application/json",
    "User-Agent": USER_AGENT,
  };

  const httpError = async (response: Response): Promise<string> => {
    let detail = "";
    try {
      const body = (await response.json()) as { error?: { message?: string } };
      if (body?.error?.message) detail = ` ${body.error.message}`;
    } catch {
      detail = "";
    }
    switch (response.status) {
      case 400:
        return `The ${actorLabel} run was rejected as invalid input.${detail}`;
      case 401:
        return "Invalid Apify token. Check your APIFY_TOKEN environment variable.";
      case 402:
        return "Insufficient Apify credits. Check your account balance at https://console.apify.com/billing";
      default:
        return `Apify request to ${actorLabel} failed with status ${response.status}.${detail}`;
    }
  };

  // 1. Start the run.
  let started: Response;
  try {
    started = await fetch(
      `https://api.apify.com/v2/acts/${actorPath}/runs?timeout=${ACTOR_RUN_TIMEOUT_SECS}`,
      { method: "POST", headers, body: JSON.stringify(input) },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `Could not reach the Apify API: ${message}` }] };
  }
  if (!started.ok) {
    return { isError: true, content: [{ type: "text", text: await httpError(started) }] };
  }

  let run: { id?: string; status?: string; defaultDatasetId?: string };
  try {
    run = ((await started.json()) as { data?: typeof run }).data ?? {};
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run start returned a response that could not be parsed: ${message}` }] };
  }
  const runId = run.id;
  if (!runId) {
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run start returned no run id, so there is nothing to wait for.` }] };
  }

  // 2. Poll to a terminal status.
  const deadline = Date.now() + WRAPPER_WAIT_MS;
  let status = run.status ?? "READY";
  let datasetId = run.defaultDatasetId;
  while (!TERMINAL.has(status)) {
    if (Date.now() >= deadline) {
      return {
        isError: true,
        content: [{ type: "text", text: `The ${actorLabel} run ${runId} was still ${status} after ${Math.round(WRAPPER_WAIT_MS / 1000)} seconds and this call stopped waiting. The run itself is still on Apify: read it at https://console.apify.com/actors/runs/${runId}` }],
      };
    }
    await sleep(POLL_INTERVAL_MS);
    let poll: Response;
    try {
      poll = await fetch(`https://api.apify.com/v2/actor-runs/${runId}`, { headers });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { isError: true, content: [{ type: "text", text: `Lost contact with the Apify API while waiting for ${actorLabel} run ${runId}: ${message}` }] };
    }
    if (!poll.ok) {
      return { isError: true, content: [{ type: "text", text: await httpError(poll) }] };
    }
    const body = (await poll.json()) as { data?: { status?: string; defaultDatasetId?: string } };
    status = body.data?.status ?? status;
    datasetId = body.data?.defaultDatasetId ?? datasetId;
  }

  // 3. A run that did not succeed is a failure the caller must see, never an
  // empty success. Surfacing it here is what keeps a crashed run from reading
  // as "no results found".
  if (status !== "SUCCEEDED") {
    return {
      isError: true,
      content: [{ type: "text", text: `The ${actorLabel} run did not succeed (run ID: ${runId}, status: ${status}).` }],
    };
  }
  if (!datasetId) {
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run ${runId} succeeded but reported no dataset, so there is nothing to return.` }] };
  }

  // 4. Read the dataset.
  let ds: Response;
  try {
    ds = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?format=json`, { headers });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `Could not read the ${actorLabel} dataset: ${message}` }] };
  }
  if (!ds.ok) {
    return { isError: true, content: [{ type: "text", text: await httpError(ds) }] };
  }

  let items: unknown;
  try {
    items = await ds.json();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run returned a response that could not be parsed: ${message}` }] };
  }

  if (!Array.isArray(items)) {
    const asObj = items as { error?: { type?: string; message?: string } };
    const detail = asObj?.error?.message
      ? `${asObj.error.message}`
      : JSON.stringify(items);
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run did not return a dataset. ${detail}` }] };
  }

  return { content: [{ type: "text", text: JSON.stringify(items, null, 2) }] };
}

const server = new McpServer({
  name: "mamba-career-change-signal-engine",
  version: pkg.version,
});

// Career Change Signal Engine (immutable actor ID vX2Yga1a6wGaXaP14). Every buyer facing input of the live actor
// is exposed; provider keys are the caller's own and go straight to the run.
server.registerTool(
  "watch_career_changes",
  {
    title: "Watch career changes",
    description:
      "Read a watch list of contacts and return only what changed since the last run: who left, who landed where, who replaced them, and who started after a role closed. Each row carries evidence, a source date, a segment, a first line draft, and Slack, HubSpot, HeyReach, and Instantly payloads. Pass people (required) and, optionally, replies, bounces, posting changes, suppression, and your own provider keys in providerKeys; it never fetches LinkedIn and holds no key of its own. State is kept per watch_list_id. A run that does not succeed is returned as an error with its run ID. Requires an APIFY_TOKEN and consumes Apify credits per call.",
    annotations: {
      title: "Watch career changes",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      people: z.array(z.record(z.string(), z.unknown()))
        .describe("Your watch list, one object per person: person_name, profile_url (optional), company_domain, company_name, title, work_email, relationship (prospect, mgl, deal_contact, customer_champion), external_id, crm_id, deal_id, known_history (a HeyReach copy, a Proofed LinkedIn reader row, or generic roles), last_reading (with state_source caller). The engine reads only these people. At most max_people_per_run per run."),
      watch_list_id: z.string()
        .optional()
        .describe("Names the list. State is kept per watch list id when state_source is actor."),
      state_source: z.enum(["actor", "caller"])
        .optional()
        .describe("actor: the engine keeps state between runs in a named store. caller: you send last_reading per person and keep state yourself."),
      read_mode: z.enum(["stored_first", "live_only", "stored_only"])
        .optional()
        .describe("stored_first: your known_history first, then your keys. live_only: ignore known_history. stored_only: only known_history, no key calls."),
      first_run_mode: z.enum(["report", "baseline"])
        .optional()
        .describe("report: the first run returns every change it finds. baseline: the first run stores state and returns nothing, charging only contact_checked."),
      max_people_per_run: z.number().int()
        .optional()
        .describe("A list longer than this fails the run before any read or charge. Default 150, at most 1,000."),
      providerKeys: z.record(z.string(), z.unknown())
        .optional()
        .describe("Your own keys: serper or serpapi (web search), prospeo, bounceban (verifier), findymail, exa. Never written to state, output, logs, or the webhook. Your own key, sent as a run input; never stored by the actor."),
      linkedin_reader_dataset_id: z.string()
        .optional()
        .describe("Optional: the dataset id of a Proofed LinkedIn reader run on the same Apify account. Rows join to people by profile URL."),
      replies: z.array(z.record(z.string(), z.unknown()))
        .optional()
        .describe("Optional reply texts: external_id or work_email or profile_url, text, received_at, channel, is_auto_reply. Text is classified and dropped; only its sha1 is kept."),
      bounces: z.array(z.record(z.string(), z.unknown()))
        .optional()
        .describe("Optional bounces: work_email, bounce_type, smtp_code, smtp_text, bounced_at."),
      posting_changes: z.array(z.record(z.string(), z.unknown()))
        .optional()
        .describe("Optional Account Hiring Watch rows. A closed posting starts a new hire search at that company."),
      suppression: z.record(z.string(), z.unknown())
        .optional()
        .describe("emails, profile_urls, opted_out_emails, opted_out_profile_urls, company_domains, company_names. Suppressed people are dropped before the read and cost nothing."),
      icp_tiers: z.record(z.string(), z.unknown())
        .optional()
        .describe("Optional map of company domain to tier, shown on landed rows. Never blocks a row."),
      features: z.record(z.string(), z.unknown())
        .optional()
        .describe("Switches: replacement, closed_posting, contact_data, first_line, icp, include_promotions. Defaults on except include_promotions."),
      sender_context: z.string()
        .optional()
        .describe("Optional topic phrase for the first line draft, for example: content production at scale."),
      max_replacement_candidates: z.number().int()
        .optional()
        .describe("Candidates proposed per leaver. A person confirms each."),
      max_spend_usd: z.number().int()
        .optional()
        .describe("Stops the run before a charge that would cross it."),
      sweep_interval_days: z.number().int()
        .optional()
        .describe("With state_source actor, a person read within this many days is skipped."),
      concurrency: z.number().int()
        .optional()
        .describe("People read at once."),
      webhook_url: z.string()
        .optional()
        .describe("Optional: signed Standard Webhooks POST of up to 100 signal rows per request."),
      webhook_secret: z.string()
        .optional()
        .describe("Signing secret; a whsec_ value is base64 decoded. Your own key, sent as a run input; never stored by the actor."),
    },
  },
  async (args) => runActor("vX2Yga1a6wGaXaP14", "Career Change Signal Engine", compact(args as Record<string, unknown>)),
);

const transport = new StdioServerTransport();
await server.connect(transport);
