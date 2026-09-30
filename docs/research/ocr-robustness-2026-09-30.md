# Automatic-region OCR robustness experiment

This follow-up to the [OCR pilot](ocr-pilot-2026-09-29.md) evaluates automatic region discovery from complete images, complementary recognition and explicit uncertainty. It distinguishes candidate recall from provisionally corroborated output. [Investigation #8](https://github.com/kelchm/lemon-manuals-mcp/issues/8) records the completed bounded evaluation; [follow-up #9](https://github.com/kelchm/lemon-manuals-mcp/issues/9) tracks independent validation of the next region policy. All inference and source-level review artifacts remain local; this document publishes aggregate evidence only.

## Scope and scoring

The frozen split contains the original 20 development images and 35 previously unreviewed images selected deterministically by vehicle/category from the cached 500-image corpus. All are CHARM-source. The latter had earlier classical processing but were not used for manual model selection. This is a purposive challenge, not representative archive sampling or previously unprocessed data.

Before inspecting the new OCR outputs, 107 exact regional targets were provisionally transcribed from eight of the 35 images: 35 pins, 39 callouts, eight component codes, seven circuit numbers, two part numbers and 16 numeric values. These references remain subject to human adjudication and do not constitute complete-page transcription. Development results use already-exposed references; one disputed reference is excluded from definitive scoring.

An exact regional match requires a token-boundary match and a predicted box center inside the target window. Matching preserves lookalike identifiers, decimal points and signs, while explicitly normalizing Unicode presentation forms such as circled digits. Some older development references have no region and therefore measure the weaker condition of token presence. A correct candidate somewhere among alternatives does not establish correct selection or precision.

## Method

PP-OCRv6 medium and docTR DB ResNet-50/PARSeq each scan four whole-image quarter-turn views and overlapping 960-pixel tiles, with 192-pixel overlap and 2× tile scale. Detections are transformed into original-image coordinates. Generic closed-shape and circle proposals supplement OCR detections. Region grouping preserves competing strings, distinct model families and repeated-view counts; four rotations of one model are not four independent votes.

The bounded discovery pass processed 1,104 views per backend over 55 images without hitting its view or shape-proposal limits. It retained 12,561 spatial proposals, of which 7,614 entered the VLM queue. The 192-region per-image limit left 4,947 proposals unprocessed across 22 images. These are explicit unresolved proposals, not inferred failures or successes; proposal counts are not counts of true text regions.

A cached docTR page-orientation classifier proposes a correction, requiring score ≥0.9 and no conflict with the physical text axis. Otherwise the original pixels are preserved and orientation remains uncertain. Twenty-eight pages were marked uncertain. Four controlled rotations caught and corrected a direction-conversion bug before VLM inference. Separately, source inspection found a genuine classifier failure: it confidently rotated an upright held-out page by 180 degrees. That result remains in the frozen run and diagnostic review; the confidence threshold is not a sufficient correctness gate.

Native local PaddleOCR-VL and GLM-OCR read the same automatic crops. Crops are enlarged up to 4×, capped at a 768-pixel longest side and padded with 16 white pixels. Each model uses its native OCR prompt, greedy generation and a 96-token ceiling, plus a synthetic blank control. Neither expected strings, manual reference regions nor page titles enter model prompts. Checkpoint identities are those in the [pilot methodology](ocr-pilot-methodology.md); GLM-OCR uses native Transformers here instead of the earlier vLLM serving path.

Provisional corroboration requires matching nonempty responses from both VLMs and a matching classical observation with score ≥0.8. Conflicting text supported by both classical families blocks corroboration. Truncation, missing evidence, multiline localization and ambiguous-orientation 6/9 readings remain unresolved. Two VLMs agreeing on a shape without classical support cannot promote it. These rules are experimental and uncalibrated; shared errors remain possible.

## Candidate recall

The multi-view classical union contains all 107 provisional held-out targets in their annotated regions. The original-orientation whole-image passes recover 96/107 with PP-OCRv6 medium and 97/107 with docTR. This supports testing multiple views and complementary detectors, but it says nothing about how much extra wrong text the union contains.

| Held-out target type | Targets | RapidOCR whole image | docTR whole image | Classical multi-view union |
|---|---:|---:|---:|---:|
| Pins | 35 | 30 | 26 | 35 |
| Callouts | 39 | 34 | 38 | 39 |
| Component codes | 8 | 7 | 8 | 8 |
| Circuit numbers | 7 | 7 | 7 | 7 |
| Part numbers | 2 | 2 | 2 | 2 |
| Numeric values | 16 | 16 | 16 | 16 |

On the exposed development references, the same union recovers 55/57 component codes, 45/45 pins, 35/35 callouts and 28/28 undisputed circuit targets. The remaining component-code misses involve a letter/digit lookalike. Those results are development evidence, not independent validation.

The automatic VLM crop union recovers 104/107 held-out targets; adding it to the classical candidates does not raise the already-complete selected-anchor recall. GLM-OCR alone recovers 100/107. The combined candidates still miss the same two development identifiers. This run does not show that more recognition models alone solve the remaining failures.

## Corroboration and observed failures

The rule marks 3,422/7,614 proposed regions as provisionally corroborated and leaves 4,192 for review. The corroborated outputs contain 87/107 held-out targets (81.3%) and 137/165 undisputed development targets. Those are coverage figures, **not precision estimates**. The unprocessed proposal backlog remains additional unresolved coverage.

| Held-out target type | Corroborated targets | Total targets |
|---|---:|---:|
| Pins | 27 | 35 |
| Callouts | 28 | 39 |
| Component codes | 7 | 8 |
| Circuit numbers | 7 | 7 |
| Part numbers | 2 | 2 |
| Numeric values | 16 | 16 |

Source inspection found a concrete counterexample to trusting agreement: an automatic crop cut through a longer identifier, and both VLMs agreed with a high-confidence classical reading of its fragment. The rule corroborated an incomplete identifier. Very small false detections also produced crops containing only portions of glyphs. Matching strings cannot establish that the proposed region contains a complete label. Together with the confidently wrong page rotation, this makes source geometry and crop completeness explicit next quality gates.

Both blank controls contained no extracted text after formatting normalization; GLM returned an empty Markdown fence. Two GLM generations and one Paddle generation hit the 96-token ceiling and remained unresolved. A successful blank control does not rule out false text in diagram shapes or clipped image content.

## Runtime boundary

Both Sparks were checked idle before this run. The head ran sequential bounded containers; the worker was not used. The cached native batch runtime avoided the previously failing Paddle vLLM path. No system-wide packages, MCP changes, index updates or deployment changes were needed.

Each phase had a 12 GiB Docker cgroup limit, zero swap, four CPU equivalents, separate CUDA allocator limits, an internal timeout and host-memory guards. Source mounts were read-only and inference networking was disabled. Image reads were size-bounded and hash-verified, with file-specific cache advice where supported. Neither cache advice nor the Docker cap proves a complete shared CPU/GPU-memory ceiling. Cgroup, CUDA allocator and host measurements overlap and must not be added.

| Completed phase | Work | Seconds | Cgroup peak GiB | Sampled NVIDIA-process peak GiB |
|---|---|---:|---:|---:|
| PP-OCRv6 medium multi-view | 55 images / 1,104 views | 556.3 | 2.189 | 2.998 |
| docTR multi-view | 55 images / 1,104 views | 440.0 | 2.637 | 2.313 |
| GLM-OCR crop recognition | 7,614 crops + blank | 455.3 | 2.808 | 2.650 |
| PaddleOCR-VL crop recognition | 7,614 crops + blank | 424.6 | 2.700 | 2.307 |

These four timed phases totaled 31.3 minutes. Timing includes model startup, image reads and output writes, but excludes environment preparation, archive collection, region grouping, orientation, annotation and human review. The CPU orientation step used a 0.737 GiB cgroup peak; its 1.6-second model-work interval excludes library imports. Every full phase completed, cleanup was verified and all recorded cgroup memory-event counters were zero. The head's sampled free memory stayed above 103.5 GiB during the full phases. This idle-host headroom does not validate running alongside the foreground GLM workload. The bounded per-image crop ceiling also prevents treating these timings as complete-corpus throughput.

## Acceptance boundary

The private offline review queue contains 50 regions: 20 unresolved candidates, 16 apparently corroborated readings, ten cases with an empty prediction from at least one model, and four reference/orientation checks. Crop outlines expose clipping, full source images provide context, and OCR suggestions remain hidden until the reviewer chooses to reveal them. Answers export with source-region identities and an analysis fingerprint. This targeted diagnostic queue is not an unbiased precision sample. Export/import and browser persistence were checked with temporary test answers, then reset.

## Completed human review

The user completed all 50 cases on September 30. The export's analysis fingerprint, case identities and source boxes match the frozen queue. Its original bytes are retained privately and unchanged; source-checked adjudications are separate records. Suggestions were never revealed in 45 cases and revealed in five. The export does not record reveal timing, so those five cannot be described as fully blinded.

| Review bucket | Clear text | No readable text | Ambiguous | Needs context |
|---|---:|---:|---:|---:|
| Unresolved candidates | 8 | 7 | 5 | 0 |
| Corroborated candidates | 16 | 0 | 0 | 0 |
| At least one empty prediction | 0 | 9 | 0 | 1 |
| Reference/orientation checks | 4 | 0 | 0 | 0 |

Fourteen of the 16 corroborated strings exactly match the raw human transcription after the existing Unicode/whitespace normalization. Source inspection reconciled the other two as a punctuation omission and a typing discrepancy in the review. This supports their literal crop readings, **not completeness or end-to-end precision**: the known identifier fragment was legible inside its crop, while the full source shows the identifier continues beyond that boundary.

All 16 crops marked as containing no readable text were already unresolved by the corroboration rule. Paddle produced nonempty output on 14 of them and GLM on seven. These are targeted diagnostic counts, not model false-positive rates on the archive. Notes identify cut characters, oversized boxes containing diagram shapes, and a crop combining two rotated labels. A single serialized string cannot establish separate labels' locations or reading order.

The user resolved the disputed circuit reference in favor of the alternative reading; both classical and VLM candidate sets contain that reading in the source region, but the corroboration rule does not select it. The two letter/digit identifier references were confirmed, with suggestions revealed for one of those cases. Their readings remain missing from the automatic candidate sets in this run. Frozen reference files, baseline denominators and the earlier metrics remain unchanged; these resolutions are versioned post-review evidence. This 50-case diagnostic review does not adjudicate every one of the separate 107 held-out reference targets.

## Containment safeguard replay

Inspection of the fragment failure found that the complete containing identifier was already supported by both classical families in the retained observations. Grouping had separated its shorter fragment and allowed corroboration without consulting that surrounding evidence.

A local post-review replay adds a narrow review flag: a corroborated alphanumeric string is a possible fragment when at least 90% of its box lies in a box at least 1.25 times larger, and that containing box has a longer alphanumeric reading containing the shorter string, supported by two distinct classical families at score ≥0.8. It retains both readings and requests review; it does not silently replace a fragment with the longer text. Whole words within a multiword phrase, neighboring nonoverlapping labels, single-family evidence and letter/digit substitutions do not satisfy this rule.

The replay flags 73 of the 3,422 previously corroborated candidates, including the known incomplete identifier. It leaves 3,349 provisionally corroborated candidates. Selected-anchor coverage is unchanged at 87/107 held-out and 137/165 development targets; among the 16 reviewed corroborated cases, only the known fragment is flagged. These are results on the already-inspected corpus, not independent validation. The other 72 flags are not asserted to be errors, and the guard does not solve all clipping, shape hallucination, multi-label or orientation problems. No new inference or Spark workload was run for this replay.

## Next acceptance gate

Near-perfect trusted extraction requires independently adjudicated predictions, including agreements and no-text regions, plus explicit abstention where evidence is ambiguous. It also requires measuring missed regions and unresolved coverage, not merely whether expected tokens appear somewhere. The current experiment does not establish calibrated confidence, complete-page accuracy, wiring relationships, archive-wide performance or safe unattended coexistence with GLM. GPU follow-up remains an idle-window workload. Retrieval integration and its own acceptance tests remain separate work in [issue #7](https://github.com/kelchm/lemon-manuals-mcp/issues/7).

**Decision:** the bounded investigation supports multi-view candidate discovery and explicit abstention, but does not support trusted unattended extraction. Human review identifies region completeness, non-text rejection, separate label localization and local orientation as the next quality gates. The containment replay is a useful first guard, with independent validation still required. Preserve the frozen results and evaluate the next policy on new examples before any archive-wide run.

Twelve focused geometry/reconciliation tests passed for the original experiment. Ten additional synthetic checks cover review-export validation and the containment guard, including source mismatch, incomplete review, immutable answers, neighboring labels, word boundaries and lookalikes. The review interface's source display, export, import and persistence were checked; test answers were cleared before the user's review. Final experiment checks found no running containers, GPU processes or pilot processes on either Spark, and the temporary local review server was stopped. The review follow-up required no Spark access. No MCP implementation, merge or deployment was performed.
