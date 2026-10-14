# Career Change Signal Engine MCP Server

[![Smithery](https://smithery.ai/badge/mambabuilt/mcp-career-change-signal-engine)](https://smithery.ai/servers/mambabuilt/mcp-career-change-signal-engine) [![Glama score](https://glama.ai/mcp/servers/mambalabsdev/mcp-career-change-signal-engine/badges/score.svg)](https://glama.ai/mcp/servers/mambalabsdev/mcp-career-change-signal-engine) [![MCP Registry](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fregistry.modelcontextprotocol.io%2Fv0%2Fservers%3Fsearch%3Dcom.mambabuilt%252Fmcp-career-change-signal-engine%26limit%3D1&query=%24.servers%5B0%5D._meta%5B%22io.modelcontextprotocol.registry%2Fofficial%22%5D.status&label=mcp%20registry&color=blue)](https://registry.modelcontextprotocol.io/v0/servers?search=com.mambabuilt/mcp-career-change-signal-engine&limit=1) [![npm version](https://img.shields.io/npm/v/@mambalabsdev/mcp-career-change-signal-engine)](https://www.npmjs.com/package/@mambalabsdev/mcp-career-change-signal-engine) [![npm downloads](https://img.shields.io/npm/dm/@mambalabsdev/mcp-career-change-signal-engine)](https://www.npmjs.com/package/@mambalabsdev/mcp-career-change-signal-engine) [![license](https://img.shields.io/github/license/mambalabsdev/mcp-career-change-signal-engine)](https://github.com/mambalabsdev/mcp-career-change-signal-engine/blob/main/LICENSE) [![mcpservers.org](https://img.shields.io/badge/mcpservers.org-listed-blue)](https://mcpservers.org/servers/mambalabsdev/mcp-career-change-signal-engine)

An MCP server for the Mamba Labs Career Change Signal Engine actor on Apify. Career Change Signal Engine reads the people on your watch list and returns only what changed since you last checked: who left, who landed where, who replaced them, and who started after a role closed. Every row says how the person was matched, which source answered, and how old that source is.

## What's Inside

- [What it does](#what-it-does)
- [Quick start](#quick-start)
- [Prerequisites](#prerequisites)
- [Example prompts](#example-prompts)
- [Tool](#tool)
- [Inputs](#inputs)
- [Pricing](#pricing)
- [Your keys](#your-keys)
- [Full actor documentation](#full-actor-documentation)
- [License](#license)

## What it does

Read a watch list of contacts and return only what changed since the last run: who left, who landed where, who replaced them, and who started after a role closed. Each row carries evidence, a source date, a segment, a first line draft, and Slack, HubSpot, HeyReach, and Instantly payloads. Pass people (required) and, optionally, replies, bounces, posting changes, suppression, and your own provider keys in providerKeys; it never fetches LinkedIn and holds no key of its own. State is kept per watch_list_id. A run that does not succeed is returned as an error with its run ID. Requires an APIFY_TOKEN and consumes Apify credits per call.

All of the work runs on Apify. This package is a thin client that starts the actor run, waits for it, and hands back the dataset rows.

## Quick start

You need Node.js 18 or newer and an Apify account with an API token.

Add this to your Claude Desktop config (`claude_desktop_config.json`), Cursor, or any MCP client:

```json
{
  "mcpServers": {
    "mamba-career-change-signal-engine": {
      "command": "npx",
      "args": [
        "-y",
        "@mambalabsdev/mcp-career-change-signal-engine"
      ],
      "env": {
        "APIFY_TOKEN": "your-apify-token"
      }
    }
  }
}
```

Restart the client. The `watch_career_changes` tool appears.

## Prerequisites

- Node.js 18 or newer.
- An Apify API token from [console.apify.com/account/integrations](https://console.apify.com/account/integrations), set as `APIFY_TOKEN`. The server lists its tool without a token; a call needs one.

## Example prompts

- "Check my 50 past champions and tell me who left and where they landed."
- "Run my watch list and draft a first line for each person who changed jobs."

## Tool

`watch_career_changes`. One tool. Example arguments:

```json
{
  "people": [
    {
      "person_name": "Jane Doe",
      "company_domain": "example.com",
      "company_name": "Example Inc",
      "title": "Head of Content",
      "external_id": "example-1"
    }
  ],
  "watch_list_id": "default"
}
```

## Inputs

Every buyer facing input of the live actor, unchanged. Omitted inputs take the actor's own defaults.

| Input | Type | Required | Description |
|---|---|---|---|
| `people` | array | yes | Your watch list, one object per person: person_name, profile_url (optional), company_domain, company_name, title, work_email, relationship (prospect, mgl, deal_contact, customer_champion), external_id, crm_id, deal_id, known_history (a HeyReach copy, a Proofed LinkedIn reader row, or generic roles), last_reading (with state_source caller). The engine reads only these people. At most max_people_per_run per run. |
| `watch_list_id` | string | no | Names the list. State is kept per watch list id when state_source is actor. |
| `state_source` | string | no | actor: the engine keeps state between runs in a named store. caller: you send last_reading per person and keep state yourself. |
| `read_mode` | string | no | stored_first: your known_history first, then your keys. live_only: ignore known_history. stored_only: only known_history, no key calls. |
| `first_run_mode` | string | no | report: the first run returns every change it finds. baseline: the first run stores state and returns nothing, charging only contact_checked. |
| `max_people_per_run` | integer | no | A list longer than this fails the run before any read or charge. Default 150, at most 1,000. |
| `providerKeys` | object | no | Your own keys: serper or serpapi (web search), prospeo, bounceban (verifier), findymail, exa. Never written to state, output, logs, or the webhook. Your own key, sent as a run input; never stored by the actor. |
| `linkedin_reader_dataset_id` | string | no | Optional: the dataset id of a Proofed LinkedIn reader run on the same Apify account. Rows join to people by profile URL. |
| `replies` | array | no | Optional reply texts: external_id or work_email or profile_url, text, received_at, channel, is_auto_reply. Text is classified and dropped; only its sha1 is kept. |
| `bounces` | array | no | Optional bounces: work_email, bounce_type, smtp_code, smtp_text, bounced_at. |
| `posting_changes` | array | no | Optional Account Hiring Watch rows. A closed posting starts a new hire search at that company. |
| `suppression` | object | no | emails, profile_urls, opted_out_emails, opted_out_profile_urls, company_domains, company_names. Suppressed people are dropped before the read and cost nothing. |
| `icp_tiers` | object | no | Optional map of company domain to tier, shown on landed rows. Never blocks a row. |
| `features` | object | no | Switches: replacement, closed_posting, contact_data, first_line, icp, include_promotions. Defaults on except include_promotions. |
| `sender_context` | string | no | Optional topic phrase for the first line draft, for example: content production at scale. |
| `max_replacement_candidates` | integer | no | Candidates proposed per leaver. A person confirms each. |
| `max_spend_usd` | integer | no | Stops the run before a charge that would cross it. |
| `sweep_interval_days` | integer | no | With state_source actor, a person read within this many days is skipped. |
| `concurrency` | integer | no | People read at once. |
| `webhook_url` | string | no | Optional: signed Standard Webhooks POST of up to 100 signal rows per request. |
| `webhook_secret` | string | no | Signing secret; a whsec_ value is base64 decoded. Your own key, sent as a run input; never stored by the actor. |

## Pricing

Pay per event on Apify, billed to your Apify account. Prices in USD.

| Event | Free plan | Bronze | Silver | Gold |
|---|---|---|---|---|
| `contact_checked`, per contact checked | $0.02 | $0.019 | $0.018 | $0.017 |
| `signal_delivered`, per change row delivered | $0.068 | $0.0646 | $0.0612 | $0.0578 |
| `apify-actor-start`, per run start | $0.001 | $0.001 | $0.001 | $0.001 |

## Your keys

The actor holds no provider key of its own. Every paid provider key is yours, passed as an input and stored by Apify as a secret input. Without a key, the actor skips that step and says so in the run.

## Full actor documentation

[apify.com/mambalabs/career-change-signal-engine](https://apify.com/mambalabs/career-change-signal-engine)

## License

MIT. See [LICENSE](LICENSE).
