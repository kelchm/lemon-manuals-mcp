# OCR pilot methodology and reproduction limits

This accompanies the [aggregate report](ocr-pilot-2026-09-29.md). It describes the experiment performed on September 28–29, 2026 and a protocol for an analogous evaluation using a user's own data. It is not an executable benchmark package or a claim that the proposed portable architecture already exists.

## Publication boundary

The public record includes hardware/runtime settings, model identities, aggregate counts and measurements, failure modes, scoring rules and limitations. The frozen input manifest, page/image identifiers, source images, crops, harvested OCR, gold transcripts, model responses and review galleries remain private. They are unnecessary for understanding the conclusions but necessary for independently reproducing the exact accuracy figures. A new corpus yields a new experiment, not a replication of the reported scores.

The original finite-job harness is retained separately: its host guards, paths and some runtime images are specific to the pilot. Packaging it as a reusable tool requires configurable inputs, independently buildable runtimes and synthetic fixtures. This documentation PR contains no harness or sample data. Future public fixtures should be newly authored synthetic content or separately publishable examples with clear provenance.

## Corpus and scoring

The measured capacity corpus comprises 500 byte-unique images totaling 49.3 MiB from image-only pages across three CHARM-source vehicle manuals. Collection started from an existing native-text index, deduplicated candidate documents by their existing text/path hash, used deterministic category round-robin selection within vehicle quotas, and then deduplicated downloaded images by SHA-256. One motivating page was deliberately prioritized. Categories included connector views, wiring diagrams, locations, specifications and other images. This is purposive sampling; it does not estimate the archive-wide distribution, and it contains no LEMON-source validation.

Twenty pages were selected for manual review. Their anchors contain 57 component codes, 45 pins, 13 location phrases, 35 rotated callouts and 26 table values. These totals describe selected targets, not every word or label. Expected strings were transcribed before OCR. Callout regions and one location region were refined during manual verification without changing expected strings; the regional scoring was therefore not fully prespecified or blinded.

Classical scoring selects recognized boxes whose centers lie inside an annotated region where one is supplied. Component codes, pins and callouts use case-insensitive token-boundary matches that do not credit a substring inside another label or decimal value. Location/table prose matching normalizes Unicode, case, whitespace and punctuation while retaining decimal points and signs. There is no measured false-positive rate or complete character/word error rate.

The common VLM comparison uses whole-page code/location matching without regions, so a token found elsewhere can count. It must not be interpreted as spatially correct pin extraction. The supplied diagnostic set contains eleven crops chosen after classical failures and one synthetic blank control, totaling 29 expected crop anchors. Crops were resized by up to 4× with the longest side capped at 1024 pixels, then given a 16-pixel white border. Crop scores remain separate from whole-page scores. Structural HTML attributes, bounding-box coordinates and image links are removed before token matching so layout metadata cannot count as a recognized label. Blank outputs, repetition and generation limits are reported independently of token recall.

## Runtime and model identity

All inference ran locally on DGX Spark Linux aarch64 hosts. The measured machines have shared CPU/GPU memory. CPU configurations used RapidOCR 3.9.2 and ONNX Runtime 1.30.0 with only the CPU execution provider enabled. V5 mobile paired the mobile detector with the English mobile recognizer; v5 server used the server detector and multilingual server recognizer; v6 used its small or medium detector/recognizer pair. All RapidOCR variants retained the v4 mobile orientation classifier.

Classical settings were recognition score threshold 0.5, maximum image side 2500, detector maximum side 2000, and recognition batch size 6. ONNX intra-op threads varied by matrix cell; inter-op threads were 1, CPU memory arena disabled, and auxiliary BLAS/OpenCV thread pools limited to 1. The conventional CUDA follow-up used RapidOCR's PyTorch backend, float32 and converted PyTorch weights, with verified GPU placement and the same preprocessing. Its runtime used PyTorch 2.13.0+cu130 and Torchvision 0.28.0+cu130. CPU and CUDA runtime implementations differ even where scored anchors agree.

docTR used python-doctr 1.1.0, a DB ResNet-50 detector and PARSeq recognizer. The comparison changed detector input from 1024 to 2048, with detection batch 1 and recognition batch 6. It enabled non-straight-page processing, disabled whole-page straightening and filtered word confidence below 0.5. The local adapter copied crops with negative strides before tensor conversion; this prevented a runtime failure without altering pixel values.

The following pinned Hugging Face revisions identify the completed VLM screens. These are measured checkpoints, not an assertion that they are the best available models or suitable for every document type.

| Pilot profile | Model repository | Revision |
|---|---|---|
| paddle-vl | `PaddlePaddle/PaddleOCR-VL-1.6` | `c5630abae1d940eafe0697512a0325494b02ab42` |
| glm-ocr | `zai-org/GLM-OCR` | `2e85a62840ccac27daa451df36c736c4636b8628` |
| teleocr | `XingChen-AGI/TeleOCR` | `e92585356c0d0b7b7a65938f3da035c6593cc9a6` |
| ovisocr2 | `ATH-MaaS/OvisOCR2` | `1fc9221b7823a371d6e97f92d527cc847e24e107` |
| mineru-pro | `opendatalab/MinerU2.5-Pro-2604-1.2B` | `d3f5e08d073c21466bbabe21c71bb1e9c2e595da` |
| granite-docling | `ibm-granite/granite-docling-258M` | `982fe3b40f2fa73c365bdb1bcacf6c81b7184bfe` |
| qwen27-nvfp4 | `nvidia/Qwen3.8-27B-NVFP4` | `482ca0f3832238542f8f5295dde86b5f22711d80` |

Paddle ran through native Transformers after a separate vLLM path failed the quality screen. GLM-OCR, OvisOCR2 and Qwen NVFP4 used local vLLM servers launched by SparkRun 0.3.9. TeleOCR, Granite-Docling and MinerU used native Transformers paths. The extended native runtime used Transformers 5.17.0, with a separate Transformers 4.57.6 environment for TeleOCR. Runtime and prompt differences are part of each tested pipeline; this is not a controlled comparison of model weights alone. The incomplete Qwen BF16 run is described only as a failed screen and cannot establish a quantization-accuracy difference.

Each VLM request used one input image, with a 3072-token generation ceiling. The OpenAI-compatible client used temperature 0 and requested thinking disabled; direct single-generation native paths used `do_sample=False`. Paddle and GLM used their OCR/text-recognition prompts. Ovis requested ordered document extraction including table/image markup. Tele requested text content. Granite requested Docling output, converted from DocTags to Markdown by docling-core. MinerU used its two-step layout/recognition path for whole pages with image analysis disabled and batch/concurrency 1; supplied crops used text recognition. Each MinerU generation was capped separately. Qwen was instructed to transcribe visible text exactly, including small/rotated labels, without inference, explanation or sequence completion, and to return empty output for a blank image. No prompt or decoding sweep was performed.

## Throughput and memory accounting

Each CPU matrix cell processed the same 500-image manifest once in a dedicated systemd user-service cgroup. The initial matrix was 1 or 2 processes × 1, 2 or 4 intra-op threads × uncapped or 2 GiB memory. Later profile-specific cells are enumerated in the report. Memory-cap order alternated by process/thread configuration. No CPU affinity, repeated trials or confidence intervals were used.

The wrapper set `MemoryAccounting=yes`, `MemorySwapMax=0`, `Nice=19`, low CPU/IO weights, an approximately thirty-minute per-cell deadline and whole-cgroup cleanup. Uncapped means no cgroup RAM maximum, not unlimited runtime or swap. CPU host memory floors were 16 GiB available before launch and 8 GiB during a run. The proposed 4 GiB free-memory floor for future GLM coexistence is a different, unvalidated policy; it was not tested by these idle-host runs.

Successful-run summaries and an independent stop hook captured `memory.peak`, `memory.max`, `memory.swap.max` and `memory.events` before the cgroup disappeared. The stop hook preserved evidence when v5 server was OOM-killed under 2 GiB. A failed or partial cell has no comparable completed-corpus throughput. Startup, model load, one warmup per process, bounded local image reads and result writes were inside CPU timing; environment setup, downloads and initial archive collection were outside it. The published capacity rates do not measure network fetching or search-index import.

Conventional CUDA runs used a 12 GiB Docker cgroup cap, zero swap, four CPU equivalents, two PyTorch CPU threads and a twenty-minute timeout. PyTorch allocator limits were separately 6 GiB for docTR and 12 GiB for the RapidOCR follow-up. Model preparation occurred before measurement. Full-run rates include startup, model load, warmup, reads and output. RapidOCR weight verification is timed; docTR computes its weight digests after the timed interval but before the final memory snapshot. VLM screens instead report server startup separately from the 32-request screen. VLM server cgroup limits were 16 GiB for the small models and 48 GiB for Qwen NVFP4; the incomplete Qwen BF16 attempt used 88 GiB. Native small-model screens used a separate 6 GiB PyTorch allocator budget.

Host memory and NVIDIA process memory were sampled at approximately one-second intervals during monitored GPU runs. These are observed peaks, unlike the kernel-maintained cgroup high-water mark. Driver/device allocations can fall outside cgroup accounting on this platform, and host free-memory movement includes cache changes. RSS, cgroup usage, allocator statistics, NVIDIA process usage and host memory overlap and must not be summed.

Image/model reads were bounded and file-specific cache advice was used where supported. That advice does not prove cache eviction, and shared cached libraries may be charged to another cgroup. CPU runs did not clear global caches. SparkRun's default VLM preparation did clear the idle head's global page cache, which is one reason those recipes do not establish safe coexistence with another model. The experiment did not run GLM concurrently.

## An analogous evaluation on another installation

1. Supply a locally accessible archive or image set, freeze a private manifest, record source coverage and deduplicate by image bytes. Include image-heavy pages and ordinary native-text pages when testing retrieval integration.
2. Prepare pinned environments and weights separately from measured inference. Record hardware, runtime/backend versions, preprocessing, checkpoint hashes, model prompts and resource limits. Confirm those runtimes support the target CPU/GPU before measuring.
3. Run bounded configurations sequentially on an idle machine. Keep fetch/decode/output inside the intended worker resource budget, capture cgroup or platform-equivalent high-water accounting before teardown, and retain failures with their memory events. Repeat trials if confidence intervals or small performance differences matter.
4. Annotate a held-out sample before inspecting model output. Measure exact labels in their regions, location text, omissions, false positives and blank-control behavior. Keep diagnostic crops separate from the held-out score, and retain original-image evidence privately for review.
5. Validate actual retrieval: query → correct manual/page → matched excerpt → original image/region. Measure precision, applicability exclusions, incomplete coverage, latency, restart/resume and rebuilding an index without rerunning OCR.
6. Only then run a bounded coexistence test against the installation's real foreground workload. Measure that workload's latency, error rate and memory headroom as well as OCR throughput. Idle-machine success alone does not justify an unattended background job.

Synthetic public fixtures can exercise the portable installation, job/result contract and retrieval behavior. They cannot substitute for real-diagram accuracy or performance measurements.
