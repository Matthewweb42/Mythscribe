# Competitive Intelligence: AI Writing Tools for Fiction Authors (October 2026)

> Research compiled by the author and provided on 2026-10-07 as source of truth for planning ("Use it as truth"). Its own
> confidence markers apply: [C] confirmed from official/primary source; [S] secondary source; [E] estimate/unverified.

**Bottom line:** No major competitor currently sells what you plan to sell, which is a cheap one-time desktop app with local-first manuscripts, free BYOK/local models, and a non-expiring, at-cost-plus-20% dollar balance. That gap is real, but it is narrow and filling. The strongest incumbents (Sudowrite on polish and its fiction model, Novelcrafter on the Codex and BYOK) are subscription-and-cloud businesses. Several small newcomers (Novel Mage, Lacuna, Chapter, RaptorWrite) are already attacking the same "pay once / local / BYOK" angle. Your edge has to come from **automatic** worldbuilding tracking and consistency checking inside the editor, plus radically transparent pricing. Price alone will not do it.

## TL;DR
- **The price gap is real:** Sudowrite costs $120–$528/yr and Novelcrafter $48–$240/yr plus API fees, and both are cloud-only. A ~$30 one-time desktop app with a non-expiring dollar balance would be the cheapest serious, AI-capable fiction tool on the market. The one exception is free BYOK tools like RaptorWrite, which are web-based and gated behind a course.
- **The feature gap is narrower than it looks:** Sudowrite already has a Story Bible and "continuity across a series." Novelcrafter's Codex already auto-detects references. Novelcrafter, RaptorWrite and Novel Mage already support BYOK/local models. So **automatic** extraction of worldbuilding facts into notes, plus proactive consistency flags in the editor, is the one feature you must win on.
- **Lead with privacy and "AI-assisted, author in control":** about 45% of surveyed indie authors use AI, but 48% refuse it, mostly on ethics, and readers disapprove. Position as "your manuscript never leaves your machine" and "AI-assisted, not AI-generated," which matches Amazon KDP's no-disclosure category.

---

## 1. Executive Summary (for the project agent)

1. **Market structure.** The market has three layers:
   - **AI-native fiction tools:** Sudowrite, Novelcrafter, NovelAI, Squibler, RaptorWrite and many new entrants.
   - **Non-AI writing and planning incumbents with one-time pricing:** Scrivener, Atticus, Vellum, Plottr, Campfire.
   - **Editing tools:** ProWritingAid, AutoCrit, Grammarly, Marlowe.

   Authors also widely use general assistants. Among AI-using authors in BookBub's May 2025 survey, ChatGPT (85%) and Claude (54%) dominate.
2. **Sudowrite is the brand leader but is small and expensive.**
   - Plans run $10–$44/mo on annual billing and $19–$59/mo on monthly billing.
   - Lower tiers' credits expire monthly.
   - It is cloud-only.
   - Revenue estimates sit around $1–2M ARR, with 16 staff (unverified).
   - Its moat is Muse, its fiction-tuned model; polish; and a 25% recurring affiliate program that had paid out more than $250K by March 2024.
3. **Novelcrafter is the closest philosophical competitor.**
   - It is BYOK, supports local models and has the Codex.
   - It claims 220k+ authors.
   - But it is subscription-only ($4–$20/mo), online-only and cloud-stored.
   - It explicitly says it offers no lifetime option and has no offline mode ETA.
4. **One-time pricing is normal and loved in this market.** Examples: Scrivener $59.99, Atticus $147, Vellum $199.99–$249.99, Plottr/Campfire/Dabble/ProWritingAid lifetime licenses. Authors are primed for "pay once." Your $30 price undercuts every paid one-time competitor.
5. **The biggest risks:**
   - Non-technical authors will not set up API keys, so hosted credits must be the default path.
   - Incumbents can copy "auto-extract codex."
   - Low price plus high support load could sink a solo developer.
   - Anti-AI backlash could tarnish any "AI" brand.

---

## 2. Competitor Profiles

Each profile uses the same subsections. Prices are USD and were checked from the sources noted, mostly August–October 2026. **[C] = confirmed from official/primary source; [S] = secondary source (review/aggregator); [E] = estimate/unverified.**

### 2.1 Sudowrite (primary competitor)

**Overview**
- Fiction-only AI co-writer founded in 2020 by Amit Gupta (Photojojo, Jelly) and James Yu (Parse, sold to Facebook). [C]
- Company entity is Human Plus Plus, Inc., per its iOS listing. [C]
- Web app plus an iOS app. [C]

**Features**
- Write, Rewrite, Describe, Expand, Brainstorm, Feedback (developmental edits, line edits, "beta reads" on Professional/Max), Story Bible (characters, world, outline), Story Engine/Canvas drafting, plugins, style matching, and "ensure continuity across a series." [C]
- Proprietary fiction models **Muse and Ballad**, plus "+30 industry-leading models" (Claude, OpenAI, Gemini, DeepSeek, Mistral, open-source). [C]
- Muse is marketed as unfiltered for dark/adult content. [C]
- Write reportedly reads up to 20,000 words of your manuscript as context. [C, Sudowrite blog]
- **No BYOK, no local models, no offline mode; cloud storage.** [C/S]
- Users keep access to their projects after cancelling, but lose the AI. [C]

**Pricing/Monetization** (sudowrite.com/pricing and docs, fetched Oct 6, 2026)

| Plan | Annual billing | Monthly billing | Credits/mo | Rollover |
|---|---|---|---|---|
| Hobby & Student | $10/mo | $19/mo | 225,000 | No, expires monthly |
| Professional | $22/mo | $29/mo | 1,000,000 per docs. Pricing page shows 450,000 struck through to 1,000,000, which looks like a "2x" promotion | No, expires monthly |
| Max | $44/mo | $59/mo | 2,000,000 | Yes, 12 months |

- Free trial: about 10,000 credits, no credit card. [S]
- Purchased top-up credits **never expire** but require an active subscription. [C, Sudowrite docs/blog]
- Enterprise tier: contact sales. [S]
- **Credit-to-word conversion is opaque.** Third-party estimates vary widely:
  - 1M credits ≈ 70,000–100,000 words of Muse generation (AuthorFlows).
  - 225K credits ≈ 20,000–30,000 words of revision (UC Strategies).
  - Image generation costs 2,500 credits per image (DreamGen review).
  - [E] Treat all of these as unverified.
- **Pricing caveat:** the Professional credit amount is in flux. One review (Sept 24, 2026) describes the 1M figure as a current promotion over a 450K base.

**Traction**
- Raised **$3M in 2021**, almost entirely from individual angels (Medium/Twitter/Gumroad/WordPress founders; 500 Global and Hyphen Capital are also cited). At that time it had 300–400 paying users at about $20/mo, all from word of mouth. [C, TechCrunch Nov 2021]
- 2025 ARR of about **$1.8M** with 16 staff (GetLatka). Crunchbase-derived figures say about $1M revenue. [E] Both are unverified. GetLatka also wrongly calls it "bootstrapped."
- Founder interview: Sudowrite had its **first profitable year** "last year," i.e. it is profit-focused rather than chasing VC scale. [C, Founder Things interview; year not specified]
- iOS app: **4.4★ from 186 ratings.** [C, App Store]
- G2 has only 2 reviews. [C]
- Hiring a Senior Mobile Engineer and a Product Designer. [C, pricing page] This signals a mobile push.

**Marketing**
- **Affiliates:** 25% recurring commission for each referral's first 12 months, via Rewardful. Payment comes after the customer has paid for 60 days, by PayPal, with a 30-day cookie [S]. Coupon sites and brand bidding are banned. Gupta posted that Sudowrite had paid **over $250,000 to affiliates** by March 5, 2024, mostly to people with a single blog post or video. [C, X post] This explains the flood of "Sudowrite review/coupon" pages.
- **Programmatic SEO:** dozens of "free tool" landing pages (AI Novel Generator, Plot Generator, Fandom/Adult story generators). Comparison blog posts aimed at rivals ("Sudowrite vs RaptorWrite," "vs DreamGen," "vs Claude"). [C]
- **Community and education:** Discord, free live classes on Luma, an 11-minute "Sudowrite Simplified" explainer video, and press quotes (New Yorker, NYT, The Verge). [C]
- **Onboarding:** low-friction trial with no card, plus an optional tutorial project. [C, Sudowrite's own comparison]
- **Positioning:** "Made by writers, for writers," "AI is a phenomenal collaborator," EZ Cancel Guarantee, "we will never hold your writing hostage." [C]

**Weaknesses/Complaints**
- Credit burn and "so damn expensive" reactions on Reddit. [S]
- No unlimited tier. [S]
- Credits expire on the two lower tiers. [C]
- Continuity slips even with the Story Bible, e.g. a character's name or hair changing mid-story. [S, Tom's Guide; DreamGen review]
- Cloud-only, with no BYOK. [C]
- The pricing structure (credits that cost different amounts per model and per feature) is hard to translate into "words." [S]

**Privacy**
- "We do not use your writing to train Sudowrite or OpenAI's AI models." [C]
- "We claim no rights over anything you put into Sudowrite." [C]
- Text is still processed by third-party model providers in the cloud.

### 2.2 Novelcrafter

**Overview**
- Browser-based novel-writing platform built around the **Codex** story bible.
- Founded by "Leonie" (founder/lead developer), with "Kate" as the public face and teacher. [C, About page]
- "No venture funding." [C]

**Features**
- Codex wiki covering characters, locations, lore, subplots and items, with automatic detection of mentions and inline previews. [S]
- Scene beats, outline/plan views, chat ("Workshop Chat," Artisan tier and up), and collaboration (Specialist).
- Unlimited books, series and universes on every tier. [C]
- **BYOK only:** OpenRouter (300+ models), OpenAI, Anthropic, Google, Mistral, and local models via LM Studio/Ollama. Fixed-fee vendors such as Featherless are also supported. [C]
- **Novelcrafter supplies no AI of its own.** [C]
- **Online-only:** "you can only use Novelcrafter with an active internet connection," with no ETA for offline mode. [C, FAQ]
- API keys stay in the browser. [C]

**Pricing/Monetization** (novelcrafter.com/pricing, 2026)
- Scribe $4/mo (no AI), Hobbyist $8/mo (BYOK AI), Artisan $14/mo (chat), Specialist $20/mo (team/collab). [C]
- Annual billing gives "2 months off." [C]
- 21-day free trial with all features and no card. [C]
- **No lifetime option.** The FAQ argues that updates require ongoing revenue, though it is "open to the option at a future date." [C]
- No Black Friday sales and no PPP pricing. [C]
- Uses Paddle as merchant of record. [C, changelog]
- Real-world API spend reported by reviewers ranges from about $5–$20/mo up to $10–$50/mo. [E] This is largely because the whole Codex is sent as context with every generation. [S, PlotForge]

**Traction**
- Homepage claims "**220k+ authors**" as of Oct 6, 2026. [C] This is a sign-up claim, not paying users.
- A 157k+ figure circulated in April 2026. [S] Taken together, these suggest fast sign-up growth.
- No revenue or team-size figures found.

**Marketing**
- Founder-led education (Kate's tutorials and teaching materials), a strong help center, free generator tools (book title, character and location name generators), and author testimonials. [C]
- Positioning: "Write, without restriction," "We believe in fair pricing." [C]

**Weaknesses/Complaints**
- Steep setup and learning curve. [S]
- You must understand API keys and token costs. [S]
- Manual Codex entry. Rivals (Novarrium and others) market against this. [S]
- Subscription on top of API costs ("double paying"). [S]
- Cloud-only, with no offline mode. [C]
- Chat and other key features are gated to higher tiers. [S]

**Privacy**
- A third-party review (Apr 2026) says the privacy policy states user content is **not** used to train AI. [S, not verified first-hand]
- Prompts go directly to whichever AI provider the user chooses.
- Manuscripts sit on Novelcrafter's servers. [C]

### 2.3 NovelAI (Anlatan)

**Overview**
- Subscription AI storytelling and anime image generator. Launched April 2021, Delaware-based. [S]
- Web/PWA only. [S]

**Features**
- Fiction-tuned in-house text models, Lorebook (world info), Memory/Author's Note, text-to-speech and image generation.
- Its best writing model ("Xialong") is reportedly Opus-only as of March 2026. [S]
- Context windows are small compared with frontier models, which hurts long-novel continuity. [S]
- No BYOK.

**Pricing/Monetization**
- Tablet $10/mo, Scroll $15/mo, Opus $25/mo, **monthly only, with no annual discount.** [S, multiple 2026 sources]
- Text generation is unlimited on all paid tiers.
- Images use "Anlas": 1,000/mo on Tablet/Scroll, 10,000/mo on Opus. The pool refills each month but does not stack. [S]
- Trial only: 50 text and 30 image generations, per arcanumrpgs.com. [S]
- NovelAI's Aug 20, 2026 blog post on subscription updates made unused subscription Anlas reset to zero when a subscription ends (per arcanumrpgs.com) and added a "battery" usage limit on Opus. [S]

**Traction**
- About 2.5M total users, announced October 2023. [E, attributed to an official subreddit post, unverified]
- About 8.1M monthly visits in November 2025. [E, traffic estimate]
- About $5M ARR as of 2024. [E, GetLatka, low confidence]
- No official figures published.

**Marketing**
- Community-driven (Discord, subreddit). Strong in AI roleplay/anime circles. Privacy-first messaging.

**Weaknesses/Complaints**
- Reviewers call it "great until 90,000 words" because limited context hurts long-form continuity. [S]
- Scroll offers little over Tablet. [S]
- Its brand is tied to anime image generation, which carries reputational baggage with mainstream authors. [S]
- October 2022 breach exposed source code and model weights. User stories were not reported leaked. [S]

**Privacy**
- Historically the strongest privacy story in the category. Stories are encrypted on-device before upload, the key never leaves the device, browser-local storage is the default, and generation requests are not logged. [C, NovelAI blog 2021]
- Current encryption details are only confirmed by reviews. [S]

### 2.4 Scrivener (Literature & Latte), the non-AI incumbent

- **Overview:** the long-standing desktop standard for novelists (binder, corkboard, compile). [C]
- **Features:** desktop-native with local files. Sync to iOS is via Dropbox. **No built-in AI.** The company states Scrivener "contains no artificial intelligence" and sends no text to servers. [C]
- **Pricing:** $59.99 Mac, $59.99 Windows, $23.99 iOS. Cross-grade discount $37.95. One-time purchase with free 3.x updates and a 30-day trial. [C]
- **Traction:** large installed base. No current figures found. [Not verified]
- **Marketing:** word of mouth, NaNoWriMo-era winner discounts (historically), education discounts.
- **Weaknesses:** steep learning curve; dated UI; painful compile; no AI; weak worldbuilding database.
- **Privacy:** fully local. This is the benchmark you are matching.
- **Implication:** Scrivener proves that authors will pay about $60 once for a desktop app. Your $30 app with AI and local storage is a direct "Scrivener-plus-AI" pitch.

### 2.5 Atticus and Vellum (formatting/writing, one-time)

- **Atticus** (by Dave Chesson / Kindlepreneur):
  - **$147 one-time** with lifetime updates and a 30-day refund. [S, multiple, Sept 2026]
  - Browser-based (Windows/Mac/Linux/Chromebook). Writing, collaboration, ebook/print formatting, export to EPUB/PDF/DOCX.
  - A competitor (Lacuna) claims Atticus files live on Atticus servers and exporting needs internet. [S]
  - Marketed through Kindlepreneur's huge SEO site, Publisher Rocket's audience and a podcast. Kindlepreneur was reported at about $120K/month revenue in an older Starter Story interview. [E, dated]
- **Vellum:**
  - Ebooks **$199.99**, Press **$249.99**, one-time, **Mac-only**. [S]
  - The gold standard for formatting output; no AI.
- **Implication:**
  - Formatting/compile is a buying trigger for indies.
  - Your "compilation" feature does not need to beat Vellum. It only needs clean DOCX/EPUB export into Atticus/Vellum/KDP.
  - Kindlepreneur is a partnership target but also a competitor-owner (Atticus).

### 2.6 Planning, worldbuilding and writing apps

| Tool | Model | Price (2026, secondary sources) | AI | Platform/storage | Notes |
|---|---|---|---|---|---|
| **Plottr** | Sub or lifetime | Sources conflict: base plan $25–$60/yr, lifetime $65–$199; Pro $99–$150/yr, lifetime $599–$799 [S, conflicting] | None | Desktop (local files) + web/cloud on Pro | "30,000+ writers" [S]; visual timelines, 40+ templates; pairs with Scrivener/Word |
| **Campfire** | Freemium modular | Free base; modules from ~$2/mo; all modules ~$12.50/mo or ~$125/yr; **$375 lifetime** [S] | None found | Web, Mac, Win, iOS, Android | Worldbuilding powerhouse for SFF; pricing called "confusing" [S] |
| **Dabble** | Sub (+ lifetime) | $9/$19/$29 per mo; lifetime reported as $699 (one source says $147, likely outdated) [S, conflicting]; 14-day trial | "Basic" | Web + desktop wrappers, cloud sync | Plot Grid; co-authoring |
| **LivingWriter** | Sub | $14.99/mo or $111/yr [S] | AI assistant | Web only, no offline [S] | Beat-sheet templates |
| **Novlr** | Sub | $10/mo or $100/yr [S] | Limited | Web | Author-owned co-op messaging |
| **World Anvil** | Freemium sub | Not verified in this research | Not verified | Web, cloud | Large worldbuilding/TTRPG community; verify pricing before use |
| **Squibler** | Freemium sub | Free (~6,000 AI words/mo, 1 project, PDF only); paid from ~$16/mo annual, ~$29.99/mo monthly (sources conflict) [S] | Smart Writer AI generation | Web; Google Cloud storage [S] | Screenwriting DNA |

**Implication:** none of these combine local-first storage, a codex and real AI. Plottr and Campfire users are the natural "I want my world notes to talk to my manuscript" converts.

### 2.7 Editing and manuscript analysis competitors

**ProWritingAid**
- Pricing: Free (500-word cap); Premium $30/mo or $120/yr or **$399 lifetime**; Premium Pro $36/mo or $144/yr or $699 lifetime. [S, multiple, Aug–Oct 2026]
- **2026 price hike:** the annual plan rose from $79 to $120, and lifetime from $299 to $399. [S]
- Whole-book reports (Manuscript Analysis, Virtual Beta Reader, Plot/Character analysis) cost extra "Story Credits": $50 each, $35 with Premium, $25 with Pro. [S]
- Pledges not to train on user writing. [S]
- Used by 50% of AI-using authors in the BookBub survey. [S] This makes it the most-used fiction-specific AI tool.
- Has Scrivener integration.

**Grammarly**
- Pro listed at about $12/mo (annual) / $144/yr. [S]
- No lifetime option. Generic, not fiction-aware.

**AutoCrit**
- Pro about $180/yr on annual billing. [S]
- Fiction-specific self-editing reports.

**Marlowe (Authors A.I.)**
- Free Basic report; **$29.95 single Pro report**; Pro $19.95/mo or $159/yr (up to 48 reports/yr). [S]
- Developmental-level manuscript analysis.

**Implication**
- Authors already pay **$25–$50 per whole-manuscript AI analysis** (ProWritingAid Story Credits, Marlowe single report).
- Your "$10 covers a full line edit plus consistency check on a 100K-word novel" claim is a strong, concrete anchor against these prices.

### 2.8 RaptorWrite / Future Fiction Academy (FFA)

- **Overview:** FFA was co-founded by Elizabeth Ann West and Leland Arra. RaptorWrite is FFA's free AI writing tool; Joseph Ucuzoglu is named as its architect. [C/S]
- **Features:** web-based. BYOK via OpenRouter. Workflow modes, prompt-centric drafting, document management. [S]
- **Pricing:** RaptorWrite 1.0 is free, unlocked by enrolling in a free FFA course. FFA "Pro" is a **$499 buy-once** package, plus a "Mega" membership. [C] A competitor claims about $79/mo for the full feature set. [S, unverified]
- **Traction:** FFA claims "25K+ authors trained," 60+ courses, founded 2019. [C, FFA site]
- **Marketing:** the tool is a lead magnet for paid education. YouTube, live labs, a "publishing profitably with AI since 2021" message. Openly pro-AI, rapid-release positioning.
- **Weaknesses:** prompt-heavy; requires an API key; Sudowrite markets it as a "self-service scramble." [S]
- **Implication:** proves the BYOK-plus-education funnel works for pro-AI, high-volume indies. It is also a potential partner or affiliate channel: FFA teaches tools, and yours could be one of them.

### 2.9 Newer AI novel tools (2025–2026 wave)

- **Chapter (chapter.pub):** $97 one-time, positioned as "AI writes the book." Heavily SEO-driven comparison blog. [S]
- **Inkfluence AI:** $9.99/mo all-in-one (chapters, covers, audiobook narration). Runs a 30% recurring affiliate program. [S]
- **Novarrium:** markets "automatic extraction" story bible and "logic-locking" against contradictions. This is the closest feature overlap with your consistency checker. [S, vendor claims]
- **AIStoryHub:** free BYOK, marketed directly against Novelcrafter. [S]
- **PlotForge:** markets against Novelcrafter's BYOK cost structure. [S]
- **Implication:** the "automatic consistency" and "no subscription" messages are both being claimed by small players. You will not be first to say them. You need to be the most credible and the best executed.

### 2.10 General-purpose assistants (ChatGPT, Claude, Gemini, NotebookLM)

- **Usage:** among AI-using authors (BookBub, May 2025, n=1,229), ChatGPT is used by 85% and Claude by 54%. [S, via secondary reporting of BookBub data]
- **How authors use them:** mainly for research (81%), marketing copy (~73%), outlining/plotting (72%) and editing (70%). Drafting ranks sixth. [S]
- For continuity, authors typically paste a story bible into a Project/Gem, or load the manuscript into a long-context model or NotebookLM to ask "what color are X's eyes?" This works, but it is manual, has no awareness of the editor, and sends the full manuscript to the cloud.
- **Pricing benchmark:** about $20/mo for consumer plans with practically unlimited use. This is the price anchor Sudowrite reviewers keep comparing against. [S]
- **Implication:** your real competitor for many authors is "ChatGPT/Claude plus Word/Scrivener." Your pitch: "the same frontier models, but they already know your book, live in your editor, and never store your manuscript."

### 2.11 Local-first, open-source and BYOK desktop tools

**Novel Mage**
- Windows/macOS desktop app; local files; no cloud.
- Local models via Ollama/LM Studio, plus BYOK OpenAI/Anthropic/Google.
- Price conflict from the vendor's own pages: **$99.99 vs $149 one-time**; 7-day trial. [C/S]
- Markets directly against Novelcrafter and Sudowrite with a "works offline / your manuscript lives on your machine" table. **This is your most direct competitor on positioning.**

**Lacuna**
- Desktop writing-plus-formatting app (Windows, Mac, Linux).
- Files stored locally; **$149 one-time**; free trial. [C, vendor site]
- Positioned against Vellum and Atticus.

**Obsidian + AI plugins**
- Free and open source: Local LLM Helper, Local LLM Hub (local-only), Text Generator, Copilot, Smart Connections (BYOK + Ollama). [C/S]
- Powerful for technical worldbuilders.
- Not fiction-specific, no manuscript compile, and setup puts off non-technical authors.

**Implication:** local-first plus BYOK is already a recognized category. Your $30 price undercuts Novel Mage and Lacuna by $70–$120. Your hosted dollar balance removes the API-key barrier that all of them, plus Obsidian, impose.

---

## 3. Side-by-Side Comparison

| Product | Pricing model | Entry price | AI included or BYOK | Storage | Worldbuilding/codex | Consistency checking | Credit expiry |
|---|---|---|---|---|---|---|---|
| **Your app (planned)** | One-time + optional prepaid AI | ~$30 once | Both: BYOK/local free, hosted at cost +20% | **Local** | Auto-tracked notes (planned) | In-editor (planned) | **Never expires** |
| Sudowrite | Subscription + top-ups | $10/mo annual ($19 monthly) | Included (no BYOK) | Cloud | Story Bible | "Continuity across series" + Feedback | Monthly on Hobby/Pro; 12 mo on Max; purchased top-ups never expire |
| Novelcrafter | Subscription | $4/mo (AI from $8) | BYOK only (incl. local) | Cloud, online-only | Codex (manual entry, auto-mention detection) | Via chat/prompts | N/A (pay provider) |
| NovelAI | Subscription, monthly only | $10/mo | Included (own models) | Encrypted cloud / browser-local | Lorebook | Limited (small context) | Anlas refill monthly, don't stack |
| Scrivener | One-time | $59.99 | None | Local | Basic (binder notes) | None | N/A |
| Atticus | One-time | $147 | None | Cloud/browser (per competitor claim) | None | None | N/A |
| Vellum | One-time | $199.99 | None | Local (Mac) | None | None | N/A |
| Plottr | Sub or lifetime | ~$25–$60/yr (conflicting) | None | Local desktop + optional cloud | Characters/places/timeline | None | N/A |
| Campfire | Freemium modules / lifetime | Free; $375 lifetime | None found | Cloud + apps | Extensive | None | N/A |
| Dabble | Sub (+ lifetime) | $9/mo | Basic | Cloud | Story notes, Plot Grid | None | N/A |
| ProWritingAid | Sub or lifetime | $120/yr; $399 lifetime | Included (limited daily "Sparks") + paid Story Credits | Cloud | None | Consistency report (spelling/style), Plot/Character analysis | Daily caps reset |
| Marlowe | Per report / sub | Free; $29.95/report | Included | Cloud upload | None | Developmental report | Per report |
| RaptorWrite | Free (FFA funnel) | $0 (+API) | BYOK (OpenRouter) | Web | Basic | Prompt-based | N/A |
| Novel Mage | One-time | $99.99–$149 (conflicting) | BYOK + local | **Local** | Yes (vendor claims) | Vendor claims | N/A |
| Lacuna | One-time | $149 | Not verified | **Local** | Not verified | Not verified | N/A |
| ChatGPT/Claude | Subscription | ~$20/mo | Included | Cloud | Manual (Projects) | Manual prompting | Usage caps reset |

---

## 4. Market and Author Sentiment

- **Adoption is split almost exactly in half.** BookBub's May 2025 survey drew 1,229 respondents according to Alyssa Matesic's analysis of the data (the Alliance of Independent Authors reports 1,279) (69% self-publish only, 25% hybrid), and found:
  - **45%** currently use generative AI.
  - **48%** do not and do not plan to.
  - **7%** are undecided.
  - **84%** of non-users cite ethical concerns.
  - **74%** of AI users do not disclose their use to readers.
  - Uses ranked: research (81%), marketing copy (~73%), outlining (72%), editing (70%). Drafting ranked sixth.

  [S, multiple secondary reports of BookBub data; the primary page could not be fetched]
- **Traditional and literary authors are more hostile.** A University of Cambridge Minderoo Centre study by Dr Clementine Collett (258 novelists, 74 industry insiders) found that a third of novelists (33%) use AI in their writing process and 51% of published UK novelists believe AI is likely to end up entirely replacing their work. [S]
- **Readers push back.** A 2025 YouGov survey of U.S. readers found majorities disapprove of AI use in all five tested scenarios, including ideation and outlining. 61% would feel less fulfilled if a book turned out to be AI-written. [S, CSMonitor Aug 2026]
- **NaNoWriMo collapse.** In September 2024 NaNoWriMo said blanket condemnation of AI had "classist and ableist undertones." Authors Maureen Johnson and Daniel José Older resigned from its board. The organization closed on March 31, 2025, citing financial trouble, but the AI stance destroyed goodwill. [C, TechCrunch/Gizmodo] **Lesson:** never imply critics of AI are bigoted or backward. Respect the refusers.
- **Amazon KDP rules.** Since September 2023, KDP has required disclosure of **AI-generated** text, images and translations (even if later edited). **AI-assisted** content (author-created, AI used to edit, refine, error-check or brainstorm) needs no disclosure. The disclosure is private to Amazon. The Authors Guild welcomed the policy as a "first step." [C, Authors Guild] Secondary sources report stricter enforcement since April 2026, including takedowns of undisclosed titles. [S, unverified]
- **Positioning implication:** your core features (tracking, consistency checks, line edits, suggestions, chat queries) fall squarely in KDP's **"AI-assisted"** bucket. Ghost-writing/drafting output falls into "AI-generated." Make the distinction visible in the product, e.g. optionally mark AI-drafted passages so authors can disclose accurately. Market "assist" features first.
- **Market size:** no reliable 2026 count of active indie fiction authors was verified in this research. Treat any "X million self-published authors" figure as unverified until sourced.

---

## 5. Pricing Benchmarks and Willingness to Pay

- **Typical AI-tool spend:**
  - Sudowrite: $120–$528/yr.
  - Novelcrafter: $48–$240/yr plus about $5–$50/mo API.
  - NovelAI: $120–$300/yr.
  - ChatGPT/Claude: about $240/yr.
  - ProWritingAid: $120/yr or $399 once.
- **One-time software norms:** $60 (Scrivener) to $250 (Vellum). Lifetime licenses for Plottr, Campfire, Dabble and ProWritingAid sell at $150–$700. Authors are visibly loyal to "pay once." Many review sites push "lifetime beats subscription after 2–3 years."
- **Per-manuscript AI analysis:** $25–$50 per run (ProWritingAid Story Credits, Marlowe).
- **Subscription fatigue is a marketing theme competitors already exploit:** Novel Mage ("another subscription, another cloud account"), AIStoryHub ("Why pay for us too?"), Chapter, PlotForge.

---

## 6. Gaps and Opportunities (tied to your product)

1. **Local-first plus AI is rare among serious tools.**
   - Sudowrite, Novelcrafter, Atticus, Dabble, Squibler and LivingWriter are all cloud-based.
   - Novelcrafter cannot work offline at all.
   - Only Scrivener (no AI), Novel Mage and Lacuna are local desktop apps.
   - **Opportunity:** "Scrivener-grade local ownership plus Sudowrite-grade AI."
2. **Non-expiring dollar balance versus expiring credits.**
   - Sudowrite's lower tiers burn unused credits monthly.
   - NovelAI's Anlas don't stack.
   - **Opportunity:** "Your balance is real dollars and never expires." Pair it with an up-front cost quote in words/books. Sudowrite cannot easily match this without hurting its subscription revenue.
3. **Transparent at-cost pricing versus opaque credits.**
   - Nobody tells authors what a full line edit of their novel costs before they run it.
   - **Opportunity:** a pre-job quote ("This consistency check on 98,412 words will cost about $1.40 with Auto") is a feature in itself.
4. **No double-paying for BYOK.**
   - Novelcrafter charges $8–$20/mo *plus* API.
   - **Opportunity:** $30 once plus BYOK at zero markup is unbeatable for its 220k-author base. Target "Novelcrafter users who hate the subscription and want offline."
5. **Automatic worldbuilding tracking.**
   - The Codex and Story Bible are mostly hand-maintained; even Novelcrafter's auto-detection only *links* existing entries.
   - Sudowrite still drifts on facts.
   - **Opportunity:** auto-extract characters, places, items, timeline facts and traits from the manuscript into the author's local notes, with diffs the author approves, plus a passive "continuity lint" in the editor. This is your one feature that must be clearly best-in-class.
6. **Privacy credibility.**
   - Only NovelAI has a strong technical privacy story, and its brand carries baggage.
   - **Opportunity:** "Your manuscript never touches our servers unless you use hosted AI, and then it is passed through, not stored or logged." BYOK/local mode never touches your servers. This wins over the 48% of ethics-minded refusers who might still accept local-only grammar and consistency help.
7. **Gap between pro-AI and anti-AI authors.**
   - Sudowrite and FFA are openly pro-generation.
   - **Opportunity:** a "your words, checked by AI" brand that appeals to both camps. Drafting is available but not the headline.

---

## 7. Risks (tied to your product and pricing)

1. **API keys scare non-technical authors.** Reviewers consistently flag BYOK as a learning-curve barrier (Novelcrafter, RaptorWrite). If hosted AI is hidden or awkward, most of your target market bounces. **Mitigation:** hosted balance is the default path; BYOK is under "Advanced."
2. **Incumbents can copy.** Sudowrite has continuity features, a mobile app on the way, and the cash flow to build auto-extraction. Novelcrafter could add a desktop/offline build or a lifetime tier, which its FAQ explicitly leaves open.
3. **Crowded "pay-once/local" niche.** Novel Mage, Lacuna and Chapter already make your pricing and privacy pitch. You won't be first, so execution and community matter more than the claim.
4. **$30 may be too low for sustainability.**
   - **Payment fees:** Paddle's own comparison page lists Stripe's standard fee as 2.9% + $0.30 per transaction and Paddle's merchant-of-record fee (Paddle is used by Novelcrafter) as 5% + $0.50 per checkout transaction; a secondary pricing summary adds that products under $10 must request custom pricing from Paddle. On a $10 pack at cost +20%, your gross is about $1.67 *before* fees, leaving roughly $1.00–$1.10. [E, my arithmetic]
   - **Support burden:** support for a desktop app on three operating systems (installers, updates, local data loss, model errors) is the real cost.
   - Break-even needs volume.
5. **Local data-loss liability.** "Local-first" means your users' backups are your support tickets. Plottr reviewers note local data-loss fears. [S]
6. **Model quality and cost volatility.** Provider prices change, and "$10 covers a line edit" must stay true or it becomes a broken promise.
7. **Anti-AI backlash and stigma.** Any perceived "AI writes your book" message alienates nearly half the market. NaNoWriMo shows that one badly worded statement can do lasting damage.
8. **Hosted-AI privacy claim must be precise.** "Never stored or logged on our servers" does not cover upstream providers' retention policies (OpenRouter and model vendors). Overstating this is a trust and legal risk.
9. **Content filters.** Sudowrite markets Muse as unfiltered, and romance, dark fantasy and horror are big indie genres. If your hosted default models refuse scenes, you lose those authors. Allow model choice, including permissive models via OpenRouter or local.

---

## 8. Recommendations

### 8.1 Positioning
- **One-line pitch:** "The novel-writing app that remembers your world for you. Your manuscript stays on your computer. Pay once."
- **Lead with assistance, not generation:** tracking, consistency, line edits and "ask your book" chat come first. Drafting/ghost-writing is an available but secondary feature. This fits KDP's AI-assisted category and the 48% who reject AI generation.
- **Don't moralize about AI.** Respect writers who never use it (Scrivener-style local editor and notes work fully without AI).

### 8.2 Differentiators to emphasize (ranked)
1. Automatic worldbuilding capture plus consistency warnings inside the editor. This is the hero demo.
2. Local-first manuscripts and notes, working fully offline (with BYOK/local models).
3. Pay-once app; dollar balance that never expires; quote before every big job; costs in words/books.
4. Zero-markup BYOK and free local models (the counter to Novelcrafter's "double paying").
5. Model choice with "Auto" routing.

### 8.3 Pricing sanity check
- **$30 one-time is well positioned to undercut, possibly too well.**
  - It is half of Scrivener ($59.99), a fifth of Atticus ($147), and $70–$120 below Novel Mage/Lacuna.
  - It pays for itself against Sudowrite Hobby in 3 months (annual billing) or under 2 months (monthly billing), and against Novelcrafter Hobbyist in about 4 months.
  - **Recommendation:** consider **$39–$49** with launch/early-bird pricing at $29. It still undercuts every local competitor, signals quality next to Scrivener, and funds support. If accessibility is the priority, keep $30 but do not promise free lifetime *major* versions. Scrivener's model (free 3.x updates, paid upgrade for 4.0) is accepted by authors.
- **Cost +20% hosted AI is competitive and defensible.**
  - Rough check [E, my estimate]: a 100K-word line edit is about 130K input tokens plus about 140K output tokens. Add context overhead (2–3x input) and a consistency pass.
  - With a mid-tier model at roughly $3/M input and $15/M output (typical Sonnet-class list pricing; verify current rates), that lands around **$4–$8**.
  - So "$10 covers a line edit plus consistency check" is plausible on mid-tier models with Auto routing, **but not on top-tier models**.
  - Show this per model in the quote UI.
  - Comparison: ProWritingAid charges $25–$50 per whole-book report, and Sudowrite costs $120+/yr.
- **Consider raising the $1 trial to about $2–$3** of hosted credit, so a new user can run one full-chapter consistency check and one line edit. AuthorFlows, a competitor, says Sudowrite's 10,000-credit trial is not enough to draft a complete chapter with Muse, which it says uses 10,000–15,000 credits per 1,000 words of output. [S]
- **Add a small minimum pack or fee floor** so the $10 pack still clears payment fees.

### 8.4 Features to prioritize (MVP order)
1. A rock-solid local editor with autosave, versioning and **one-click backup** to the user's own folder or cloud drive (Dropbox/iCloud/OneDrive). This defuses the data-loss risk.
2. **Import:** DOCX, Scrivener (.scriv), Markdown, plus Novelcrafter/Sudowrite exports. This lowers switching costs. **Export:** DOCX/EPUB/Markdown, clean enough for Vellum/Atticus/KDP.
3. Auto-extracted world notes (characters, places, items, timeline) that the author approves or edits, stored as local plain files (Markdown/JSON), so the author has no lock-in.
4. A consistency checker with quoted evidence ("Ch. 3 says green eyes, Ch. 17 says brown"), run on demand with a cost quote, plus a cheap incremental mode on save.
5. Chat with manuscript and notes, with retrieval so you don't resend the whole book (cost control).
6. Line-edit and suggested-edit mode with accept/reject track changes.
7. Hosted-balance onboarding with no API key needed; BYOK/OpenRouter and Ollama/LM Studio in Advanced.
8. Optional "AI-generated passage" marking to support honest KDP disclosure.
9. Drafting/ghost-writing last, behind the above.

### 8.5 Marketing channels for a solo developer with a small budget
1. **Affiliate program (highest leverage).** Sudowrite's affiliates earned more than $250K from evergreen blog posts and videos. Offer **30–40% of the app sale** (one-time, since it's not recurring), and optionally a share of each user's first hosted-AI pack. Use Rewardful, Lemon Squeezy or Paddle affiliate tooling. Recruit AuthorTube creators and writing-tool reviewers; the market is already saturated with "Sudowrite alternative" content.
2. **Comparison SEO pages.** Every new competitor (Chapter, Novel Mage, Inkfluence, AIStoryHub) is winning with "X vs Y" and "X alternative" pages. Write honest pages: "Sudowrite alternative with no expiring credits," "Novelcrafter alternative that works offline," "Scrivener with AI," "local AI novel writing app."
3. **Reddit and Discord:** r/WritingWithAI, r/selfpublish, r/fantasywriters (follow AI rules strictly; many writing subreddits ban AI promotion), and Novelcrafter/Sudowrite-adjacent Discords. Run your own Discord for early users and feature requests.
4. **Education partnerships:** pitch FFA (pro-AI, BYOK-literate audience, 25K+ trained) and Kindlepreneur-style newsletters. Offer free licenses for reviewers and course creators.
5. **November writing-month replacement events.** NaNoWriMo is gone, but November writing challenges continue informally. Run a free "write your novel in November" challenge with a word tracker and discount.
6. **Demo-first video:** a 60-second "paste in your 100K-word novel and watch it find 14 continuity errors, for $1.40" video is your single most shareable asset.
7. **Price transparency as content:** publish your markup, your provider costs and a public "what your $10 bought" calculator. This builds trust in a market cynical about credits.
8. **Conferences** (20Books/Author Nation and similar): skip paid booths early. Attend, demo on a laptop, and court the podcasters there.

---

## 9. Caveats and Verification Gaps

- **Prices:** most third-party prices were taken from 2026 review sites. Several conflict (Plottr, Dabble lifetime, Squibler, Novel Mage, Sudowrite Professional's credit amount). Re-check official pricing pages before publishing comparison content.
- **Traction:** Sudowrite and NovelAI revenue figures (GetLatka/Crunchbase) are unverified estimates. Novelcrafter's 220k+ is a sign-up claim. NovelAI's 2.5M users comes from an unverified attribution.
- **Privacy:** Novelcrafter's no-training policy and NovelAI's current encryption details were confirmed only via third-party reviews.
- **BookBub survey:** figures come from multiple consistent secondary reports. The primary page was not directly fetched.
- **Not researched or not verified:** World Anvil pricing and features, Jenova, indie author market size, community sizes (Discord/subreddit/Facebook member counts), web-traffic estimates for most competitors, and the claim of stricter KDP enforcement in April 2026.
- **Vendor comparison pages:** many sources (Chapter, Inkfluence, Novel Mage, Lacuna, AIWriteBook) are competitors writing about rivals. Their claims about others' weaknesses are marketing, not neutral fact.
