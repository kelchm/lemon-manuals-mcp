# Fresh-image evaluation of OCR source-span safeguards

This comparison follows the [automatic-region experiment](ocr-robustness-2026-09-30.md) and is tracked in [investigation #9](https://github.com/kelchm/lemon-manuals-mcp/issues/9). It tests whether explicit source-span checks, separate labels and local orientation can improve provisional OCR selection. Source images, transcripts, references and review galleries remain private. Only methods and aggregate evidence belong in this report.

**Decision:** reject the combined revised policy. Its blanket crop-edge veto excludes intact labels and reduces selected-anchor coverage from 53/69 to 1/69. Retain containment conflicts as explicit review evidence: a separate component diagnostic flags 41 baseline readings without losing any of the 53 selected targets, and source inspection finds fresh incomplete spans among those flags. This supports further validation of that narrow check, not trusted unattended extraction.

## Frozen comparison

The split contains 24 cached CHARM-source images across 11 available vehicle/category strata, excluding all 55 content hashes in the earlier experiment. Selection uses deterministic hash ordering within strata and round-robin allocation. These images had earlier conventional processing but were not reviewed or used to tune this policy. The split is a purposive challenge, not representative archive sampling or validation on LEMON-source images.

Before inspecting new OCR outputs, 69 provisional regional anchors were transcribed from eight source images, alongside five graphical no-text controls. Source-coordinate contact sheets were checked before freezing the references. The targets include component identifiers, pins, callouts, numeric values and location text. They are selected readable anchors rather than exhaustive page gold, and remain subject to independent human adjudication. References and their coordinates never enter either inference arm.

Both arms share the unchanged PP-OCRv6 medium and docTR multi-view discovery pass, original grouping and 192-proposal-per-image limit. The baseline retains the preceding experiment's page classifier, crop padding, native GLM-OCR/PaddleOCR-VL recognition and corroboration rule. Model checkpoints, cached container and inference prompts are unchanged.

The revised arm preserves source relationships and makes the following changes:

- A possible containing alphanumeric identifier needs a matching high-score observation from each of two classical families. A maximum score shared across families is insufficient. Containing and contained readings remain separate evidence; neither silently replaces the other. This narrow guard does not cover every punctuation-bearing identifier or incomplete numeric value.
- Spatially separate, sufficiently supported sublabels receive their own source boxes. Nested detections of portions of one label are not automatically treated as separate labels. Parent relationships and any unprocessed labels are retained.
- Context expands by half the short box dimension, with a minimum of eight and maximum of 32 source pixels. Every retained label receives four local quarter-turn views, without a page-classifier override. The limits are 192 labels and 768 views per image.
- Two VLMs must agree at a local orientation and match high-score classical evidence. Rotations are correlated evidence, never independent votes. Competing supported readings, truncation, multiline output, possible fragments and orientation-sensitive isolated digits remain unresolved. Tiny or single-character readings require two high-score classical families.
- A two-pixel band at each input-crop edge is inspected for dark pixels. At least two pixels below grayscale 160 flag that edge and prevent corroboration. This is an intentionally conservative clipping signal: a crossing wire or other graphic can also trigger it.

The thresholds and split were frozen before inspecting the new outputs. No rule is relaxed after observing this comparison. A known clipped-identifier development regression remains flagged under the stricter per-family score requirement; that regression is separate from fresh-image evidence.

## Coverage and cost

Each classical backend processed 460 views across the 24 images. Grouping retained 4,236 proposals and selected 3,107 for baseline recognition; seven images hit the 192-proposal limit, leaving 1,129 original proposals outside that queue. The revised arm separates 43 larger proposals into supported sublabels and deduplicates shared children, producing 3,064 labels and 12,256 local-orientation requests per model. No additional revised-label cap was reached. The original unprocessed-proposal record is retained; proposal counts are not counts of unique true labels.

| Selected-reference metric | Baseline | Revised |
|---|---:|---:|
| Classical multi-view candidate union | 68/69 | Same shared discovery |
| VLM candidate union | 64/69 | 66/69 |
| All candidate readings combined | 68/69 | 68/69 |
| Provisionally corroborated target coverage | 53/69 | 1/69 |

The individual original-orientation whole-image passes recover 59/69 and 54/69 targets. The remaining combined-candidate mismatch concerns dash typography in a location-text reference; its transcription remains provisional. Frozen denominators and reference bytes are unchanged.

The baseline marks 1,321/3,107 regions provisionally corroborated. The revised policy marks 34/3,064 labels provisionally corroborated and leaves 3,030 unresolved. Those totals use different region sets and are not precision estimates. The crop-edge rule flags 2,900 revised labels. Source inspection confirms that wires and leader lines can cross an input boundary while the intended label remains intact. In a photographic example, expanding context also cuts through a neighboring label. More surrounding pixels do not establish which text belongs to the requested target.

Scoring uses the existing case-insensitive token-boundary matcher, preserves lookalike characters, signs and punctuation, and requires the associated box center inside the reference window. VLM responses inherit the requested target box; these native text responses do not provide word coordinates. A matching token in an expanded crop therefore does not prove that it belongs to the intended label. These metrics do not establish exact character localization or complete-page accuracy.

## Component diagnostics

These analyses explain the failed combined policy; they are exploratory and do not replace its frozen result.

Removing only the boundary veto from the revised decisions would leave 649 provisional selections, covering 42/69 targets. That remains below the baseline's 53/69, and it does not validate the precision of the additional outputs. Context expansion, separate-label handling, local orientation and stricter evidence checks are bundled changes, so their effects must not be attributed to one mechanism without further controls.

Holding the revised expanded crops fixed, the two-model union already recovers 66/69 targets at the baseline's chosen page angle. Adding the other local angles does not increase that selected-target count. GLM alone benefits from the additional angles, but the complementary model covers those targets without the extra rotations. This sample does not justify applying four VLM orientations to every label. The paired revised recognition phases take 4.27 times the baseline recognition time.

Applying only the unchanged, frozen per-family containment function to baseline decisions flags 41/1,321 readings and retains 1,280 provisional selections. Selected-anchor coverage remains 53/69. These are requests for review, not assertions that every flag is an error.

A deterministic diagnostic sample of 12 flags, with at most two per image, was inspected from source pixels before displaying the model readings. Eleven show visibly incomplete word or code spans; one contains a complete unit glyph within a larger rating and needs semantic context. This was assistant source inspection, not independent human adjudication or a population precision estimate. Some longer containing readings are themselves incomplete, which reinforces retaining alternatives rather than automatically replacing a short reading with a longer one.

Thirty of the 41 flagged baseline readings have matching high-score classical support from tile views, and eleven from whole-image views. These provenance counts do not identify the cause of each detection failure; they do show that investigating tile boundaries alone would not account for every flagged reading.

## Operational boundary

Fresh read-only checks found both Sparks idle. All inference runs sequentially on the head in the cached native batch container. The worker is unused. Each phase retains a 12 GiB cgroup limit, zero swap, four CPU equivalents, separate CUDA allocator limits, a container-internal deadline and host-memory guards. Inference networking is disabled, source mounts are read-only, and image reads are size-bounded and hash-verified. No system-wide installation is required.

The cached native batch runner was already verified with these models and avoids the previously failing Paddle vLLM serving path. SparkRun orchestration was deferred for this bounded comparison. This is an operational experiment; portable deployment packaging and the infrastructure-independent retrieval proof remain [issue #7](https://github.com/kelchm/lemon-manuals-mcp/issues/7).

Cgroup, CUDA allocator, NVIDIA process and host-memory measurements overlap. They must not be added, and the cgroup limit is not a proven total shared-memory ceiling. Idle-host measurements do not validate coexistence with the foreground GLM workload.

| Completed phase | Controller wall seconds | Cgroup peak GiB | Sampled NVIDIA-process peak GiB |
|---|---:|---:|---:|
| PP-OCRv6 medium discovery | 167.1 | 2.165 | 3.117 |
| docTR discovery | 168.5 | 2.074 | 2.309 |
| Baseline page orientation, CPU | 4.2 | 0.565 | — |
| Baseline GLM-OCR, 3,107 crops + blank | 193.2 | 2.731 | 2.512 |
| Baseline PaddleOCR-VL, 3,107 crops + blank | 187.4 | 2.411 | 2.135 |
| Revised GLM-OCR, 12,256 views + blank | 845.9 | 2.779 | 2.646 |
| Revised PaddleOCR-VL, 12,256 views + blank | 779.3 | 2.454 | 2.246 |

Controller timings total 39.1 minutes and include container startup, polling and cleanup. They exclude archive collection, transfers, crop preparation, annotation and review. Local crop preparation took about 3.3 seconds across both arms and used no inference. Both arms share the discovery work; the total includes both recognition comparisons. These bounded, capped workloads do not establish complete-corpus throughput.

All seven phases completed with verified cleanup and zero cgroup memory events. Sampled host free memory remained at least 102.8 GiB. The baseline Paddle run had one response at the 96-token ceiling; the revised GLM and Paddle runs had three and four respectively. Those responses remained unresolved. All blank controls contained no extracted text after the existing formatting normalization. Final checks on both Sparks found no running containers, GPU processes or pilot processes.

## Human acceptance

The review protocol targets 50 cases: revised corroborations, baseline-only corroborations, unresolved cases, split/orientation cases, source-only graphical controls and missed or unresolved references. Selection is deterministic within buckets, with source-image diversity where available. Bucket shortfalls are recorded. This targeted queue does not estimate archive-wide precision.

The form distinguishes the claimed source box from the model's input crop. It asks for the complete source label, including any continuation outside the box, a boundary assessment and the local orientation. OCR suggestions and policy identities are initially hidden. Edit/reveal timestamps and the answer present before suggestions were revealed are retained. Partial export and resume are supported; raw answers must remain unchanged, with adjudications recorded separately.

The 50-case queue was generated with all six target buckets filled and no sampling shortfall. Its independent human review is pending. A separate private page shows three crop-boundary examples; manual-derived content is not part of this public report.

Thirteen new synthetic checks cover family thresholds, containment, exact character identity, separate and nested spans, boundary graphics, local turns, valid short/numeric readings, conflicting rotations, truncation, proposal limits and response identity. Four further checks cover review-export identity, immutable answers, incomplete labels and reveal snapshots. All 39 checks, including the preceding experiment's 22 checks, pass. They verify mechanics rather than OCR accuracy. Export, import, persistence, source-boundary display and reveal snapshots were checked with temporary answers, which were cleared afterward.

## Next boundary

Keep the successful discovery evidence and the narrow containment review flag. The next policy should distinguish the intended text span, neighboring labels, graphical enclosures and the full input crop, with localization provenance for each reading. Plain text returned from a context crop must not silently acquire the target's coordinates. Source-view boundaries also remain relevant evidence. Any revised selection policy needs a new independent comparison; post-hoc removal of a failing veto is not acceptance evidence.

The current results do not support trusted unattended extraction or a weeks-long GPU/VLM job alongside GLM. GPU follow-up remains an idle-window workload. The original CPU recommendation—one process, four ONNX threads and a 2 GiB cap—still needs a supervised coexistence acceptance test before an unattended run. Retrieval integration can preserve uncertain candidates and link users to original source regions without promoting uncertain text to established facts; that portable proof remains separate work in issue #7.
