import { NextResponse } from "next/server";

import { LIVE_CHAIN_NAME, LIVE_SOURCE, fetchLiveOpportunities, formatFetchedAt, type LiveOpportunity } from "@/lib/yields";

/**
 * Groq analysis of live yield data.
 *
 * The security shape of this route matters more than the feature does.
 *
 * The client does NOT send the yield data. It sends pool ids, and this route
 * re-reads the numbers from the source itself. So the model can only ever see
 * figures that came off the wire — a caller cannot hand it an APY of 400% and
 * get a confident paragraph back about it. That is the difference between an
 * analysis feature and a laundering service for invented numbers.
 *
 * `GROQ_API_KEY` is read here, on the server, from the environment. It is never
 * returned to the client, never embedded in the page, and never prefixed
 * `NEXT_PUBLIC_`. When it is absent this route says so with a 503 rather than
 * answering with a canned paragraph — a fake analysis is worse than no analysis,
 * because a reader cannot tell the difference.
 */

export const runtime = "nodejs";

/**
 * Groq retired `llama-3.3-70b-versatile` on 16 August 2026 — every request for it
 * now fails with `model_not_found` — and its own deprecation guidance points
 * production users at GPT-OSS 120B. Overridable without a code change with
 * `GROQ_MODEL`, which must name a model Groq actually serves.
 */
const DEFAULT_MODEL = "openai/gpt-oss-120b";

const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";

/** One analysis covers a handful of pools, not the whole venue. */
const MAX_POOLS = 8;

const POOL_ID_RE = /^(?:llama-)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

const MODEL = process.env.GROQ_MODEL?.trim() || DEFAULT_MODEL;

export function GET() {
  // The UI asks this first, so it can say "this deployment has no AI service
  // configured" instead of offering a button that is guaranteed to fail.
  return NextResponse.json({
    ok: true,
    configured: Boolean(process.env.GROQ_API_KEY),
    model: MODEL,
    source: LIVE_SOURCE.name,
  });
}

/**
 * The prompt is the product. Every clause below exists because without it the
 * model will happily invent a TVL, name a protocol it has seen elsewhere, or
 * describe a "battle-tested, audited" vault that nobody has audited — and all
 * three of those are things this page must never say about real money.
 */
function systemPrompt(fetchedAt: string): string {
  return [
    "You are writing a short, plain-language informational analysis of stablecoin yield opportunities for FlowPay Earn, a page that compares yield markets.",
    "",
    `The YIELD DATA block in the next message is authoritative. It was read directly from ${LIVE_SOURCE.name} at ${fetchedAt}. It is the ONLY source of facts you may use.`,
    "",
    "Hard rules, in order of importance:",
    "1. Never state, estimate, infer, extrapolate, round or imply any number that does not appear in YIELD DATA. If a field is null, the value is unknown: say it is unavailable and stop. Do not supply a typical or expected value instead.",
    "2. Never name a protocol, vault, contract address, chain, token, pool or venue that does not appear in YIELD DATA. Do not compare against anything not in YIELD DATA.",
    "3. You have no information about audits, security, insurance or safety, and none is provided. Never claim, hint or imply that anything is audited, safe, battle-tested, insured, protected or endorsed. Where safety would be relevant, say plainly that the data does not cover it.",
    "4. If the data shows that part of the yield is paid in reward tokens, say so and name the reward token address from the data — reward yield is not the same kind of thing as base interest, and the reader needs to know which part is which.",
    "5. Do not tell the reader to deposit, and do not give instructions for depositing. You may say what a person should check first.",
    "6. Do not give financial advice, and do not predict future yields. Past or current figures in the data are not a forecast.",
    "7. Write plain text with no markdown symbols, no bullet characters and no headings other than the five section titles below. Keep the whole answer under 320 words.",
    "",
    "Write exactly these five sections, each a short paragraph with its title on its own line:",
    "What this opportunity is",
    "Why the yield may be attractive",
    "Important risks",
    "What FlowPay verified",
    "What to check before depositing",
    "",
    "For 'What FlowPay verified', state that FlowPay read these figures from the source at the given time, that FlowPay has not audited the protocol, and that FlowPay has no deposit integration for it. Do not add any verification beyond that.",
    "End with one final sentence saying this is not financial advice.",
  ].join("\n");
}

/** Only fields that came from the source, so the model cannot cite a derived one. */
function evidenceBlock(pools: LiveOpportunity[]) {
  return pools.map((pool) => ({
    pool_id: pool.poolId,
    symbol: pool.symbol,
    pool_meta: pool.poolMeta,
    chain: pool.chain,
    chain_id: pool.chainId,
    protocol_as_reported_by_source: pool.project,
    stablecoin_pool_per_source: pool.stablecoin,
    apy_percent: pool.apy,
    apy_base_percent: pool.apyBase,
    apy_reward_percent: pool.apyReward,
    apy_mean_30d_percent: pool.apyMean30d,
    tvl_usd: pool.tvlUsd,
    impermanent_loss_risk_per_source: pool.ilRisk,
    exposure_per_source: pool.exposure,
    underlying_token_addresses: pool.underlyingTokens,
    reward_token_addresses: pool.rewardTokens,
    read_at: pool.fetchedAt,
    source: LIVE_SOURCE.endpoint,
  }));
}

export async function POST(request: Request) {
  const key = process.env.GROQ_API_KEY;
  if (!key) {
    return NextResponse.json(
      {
        ok: false,
        code: "not-configured",
        error:
          "The AI analysis service is not configured on this deployment. It needs a GROQ_API_KEY environment variable on the server. Nothing is analysed until that is set.",
      },
      { status: 503 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, code: "bad-request", error: "Expected a JSON body with poolIds." }, { status: 400 });
  }

  const rawIds = (body as { poolIds?: unknown })?.poolIds;
  if (!Array.isArray(rawIds) || rawIds.length === 0) {
    return NextResponse.json({ ok: false, code: "bad-request", error: "poolIds must be a non-empty array." }, { status: 400 });
  }
  if (rawIds.length > MAX_POOLS) {
    return NextResponse.json(
      { ok: false, code: "bad-request", error: `At most ${MAX_POOLS} pools can be analysed at once.` },
      { status: 400 },
    );
  }

  const wanted = new Set<string>();
  for (const entry of rawIds) {
    if (typeof entry !== "string") {
      return NextResponse.json({ ok: false, code: "bad-request", error: "Every pool id must be a string." }, { status: 400 });
    }
    const match = POOL_ID_RE.exec(entry.trim());
    if (!match) {
      return NextResponse.json({ ok: false, code: "bad-request", error: `"${entry}" is not a pool id.` }, { status: 400 });
    }
    wanted.add(match[1].toLowerCase());
  }

  // The numbers are read here, from the source, not accepted from the caller.
  const live = await fetchLiveOpportunities();
  if (!live.ok) {
    return NextResponse.json({ ok: false, code: "source-unavailable", error: live.error }, { status: 502 });
  }

  const pools = live.opportunities.filter((pool) => wanted.has(pool.poolId.toLowerCase()));
  if (pools.length === 0) {
    return NextResponse.json(
      {
        ok: false,
        code: "unknown-pool",
        error: `Nothing on ${LIVE_CHAIN_NAME} mainnet matches those ids. The source may have retired the pool since this page was built.`,
      },
      { status: 404 },
    );
  }

  let response: Response;
  try {
    response = await fetch(GROQ_ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.2,
        // The retired model answered and did nothing else, so 900 tokens was the
        // whole answer. This one reasons before it writes, and the reasoning
        // comes out of the same budget: at 900 the reply stopped after two
        // sections and the risks never arrived. The cap is now the answer plus
        // that reasoning, with room to spare — the prompt still holds the answer
        // itself under 320 words.
        max_tokens: 4096,
        messages: [
          { role: "system", content: systemPrompt(formatFetchedAt(live.fetchedAt) ?? live.fetchedAt) },
          {
            role: "user",
            content: `YIELD DATA (authoritative, the only facts you may use):\n\n${JSON.stringify(evidenceBlock(pools), null, 2)}\n\nWrite the five sections now.`,
          },
        ],
      }),
    });
  } catch {
    return NextResponse.json(
      { ok: false, code: "provider-unreachable", error: "The AI provider could not be reached. Nothing was analysed." },
      { status: 502 },
    );
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    // The key itself is never echoed, here or anywhere else.
    if (response.status === 401 || response.status === 403) {
      return NextResponse.json(
        {
          ok: false,
          code: "key-rejected",
          error: `The AI provider rejected GROQ_API_KEY (${response.status}). Check the key on the server.`,
        },
        { status: 503 },
      );
    }
    if (response.status === 429) {
      return NextResponse.json(
        { ok: false, code: "rate-limited", error: "The AI provider is rate limiting this deployment. Try again shortly." },
        { status: 429 },
      );
    }
    return NextResponse.json(
      {
        ok: false,
        code: "provider-error",
        error: `The AI provider answered ${response.status}. ${detail.slice(0, 200)}`.trim(),
      },
      { status: 502 },
    );
  }

  const payload = (await response.json().catch(() => null)) as
    | { choices?: { message?: { content?: unknown } }[]; model?: unknown }
    | null;
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.trim() === "") {
    return NextResponse.json(
      { ok: false, code: "empty-response", error: "The AI provider returned an empty analysis. Nothing to show." },
      { status: 502 },
    );
  }

  return NextResponse.json({
    ok: true,
    model: typeof payload?.model === "string" ? payload.model : MODEL,
    analysedAt: new Date().toISOString(),
    // Echoed back so the page can state which data the analysis was of.
    dataReadAt: live.fetchedAt,
    poolIds: pools.map((pool) => pool.poolId),
    text: content.trim(),
  });
}
