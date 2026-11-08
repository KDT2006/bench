# Bench.it — three-minute hackathon demo

Pitch: Bench.it turns performance questions into inspectable experiments: describe the work, generate benchmark code, run it on connected hardware, and compare the measurements.

This draft follows two examples already in the repository: **Array sum** and **Branch prediction**. External reference videos/scripts and judging criteria were not supplied. The opening deck is `intro-slides.pdf`; `intro-slides.html` is the editable source and can be presented directly in a browser. Use the arrow keys or space to change slides, and F for fullscreen.

## Timed voiceover and screen direction

Read only the blockquotes. The timeline includes short pauses and edited transitions; rehearse once against the recording.

### 0:00–0:17 — Slide 1: the problem

Hold the first slide. Leave a beat after the opening question.

> AI can write two versions of your code. But which one is faster on the hardware you actually use? Answering that means building benchmarks, separating setup from execution, and making sense of the results. That work can become a project of its own.

### 0:17–0:35 — Slide 2: introduce Bench.it

Advance to slide 2. Follow the three steps with the cursor, then transition into the app.

> We built Bench.it to make that experiment easier. Describe the operation, let Gemini generate benchmark code you can inspect, then run it on connected hardware. Compare languages, implementations, and input sizes in one workbench. Let’s walk through two examples.

### 0:35–1:02 — Example 1: write the experiment

Show the launch screen briefly; click **Go**. Open **Docs → Examples → Array sum**. Show Go and Python lanes. Set `N: [1024, 65536, 1048576]` in the linked source before recording, or paste it during the take. Point to `#sweep`, `#setup`, and `#bench` as they are mentioned.

> First: should this data-processing loop stay in Python, or is a Go implementation worth investigating? Here’s an array sum in both languages. The sweep tests three input sizes. Setup prepares the data outside the timed section; the benchmark contains the work we want to measure. That makes the question explicit: how does the cost of this operation change as the input grows?

### 1:02–1:32 — Generate, execute, compare

Click **Translate** and show the generated harness tab. Show both implementations briefly. Click **Run**, retain a few seconds of progress, then cut to completion with a small “Execution wait shortened” caption. Click **Open full results**, show the time chart, and select **Relative to A**. Keep the selected statistic visible.

> Gemini translates the experiment into executable code, and we can inspect the generated implementations before running them. Bench.it sends each case to the execution servers and plots the measured times. Here, we can compare the lanes at matching input sizes and see the relative difference. This gives us evidence for whether to investigate a rewrite, grounded in these implementations and this machine. The AI helps create the experiment; the execution servers produce the measurements.

### 1:32–2:12 — Example 2: investigate a performance hypothesis

Open **Docs → Examples → Branch prediction**. Show both Go lanes, labeled **Sorted** and **Random**. Point to `sort(arr)` in the Sorted lane’s setup and the matching conditional in both benchmark sections. Show the completed run and matched-input comparison. If available, briefly show branch-miss measurements; otherwise stay on time.

> Now let’s keep the language fixed and change the data. Both lanes run a conditional sum in Go. One sorts the data during setup; the other leaves it random. Sorting is outside the timed section, so we’re comparing the loops. Predictable branches can help a CPU, but the actual effect depends on the generated code and the machine. Bench.it lets us test that hypothesis across input sizes. Where hardware counters are available, we can also inspect branch misses alongside timing. For a student, that makes a CPU concept tangible. For an engineer, it’s a focused way to investigate a performance question.

### 2:12–2:40 — Who needs it, and why

Keep the results visible. Briefly show **Execution target snapshots**, then **Export all CSV**. Return to the two lanes; avoid opening additional settings.

> The same workflow helps when reviewing an AI-generated optimization, comparing data layouts, or deciding whether a hot loop deserves more attention. Instead of rebuilding the experiment for every question, we can change a lane or sweep, inspect the code, and compare the results. The run captures the execution target, and we can export the measurements for further analysis or a team discussion.

### 2:40–3:00 — Close

Hold a readable results chart for the first sentence. End on the Bench.it launch screen; hold the logo for the final two seconds.

> Our goal is to make performance experiments accessible enough to become part of everyday development and learning. From a question, to inspectable code, to measurements on real hardware, all in one workbench. Before you optimize, measure. Bench.it.

## Recording preparation

- Record at 1920 × 1080. Increase browser zoom enough that the code and chart labels remain readable in the video. Record the voiceover separately so execution waits can be removed cleanly.
- Confirm Gemini translation and both Go and Python executors work. For the language comparison, use executors on the same physical machine. If they differ, describe it as a comparison of these configurations and show the execution targets.
- Reduce Array sum to `N: [1024, 65536, 1048576]`. With two lanes and the documented ten-second window, that is about 60 seconds of measurement windows, plus setup, translation, compilation, and request overhead. Branch prediction’s two default sizes and two lanes add about 40 seconds of measurement windows. Edit these waits; the voiceover timeline is the final video runtime.
- Inspect the translated code before recording. A Python built-in `sum` and an explicit Go loop test different implementation choices. Do not claim the experiment proves that one language is universally faster. If you intend a loop-to-loop comparison, ensure both harnesses actually use explicit loops.
- Run both examples in advance and keep their real results available in the current browser session. Live run records disappear on refresh. Export the CSVs and capture the result screens before closing or refreshing tabs.
- Use results from your actual runs. The repository includes sample data; do not present it as a fresh execution. The script deliberately makes no numerical speedup claim. If you add one, replace a sentence with the observed comparison and name the input size and selected statistic.
- A small or absent sorted/random difference is a valid result. Do not promise a branch-prediction speedup. If branch counters are unavailable, leave the timing chart on screen while saying “where hardware counters are available.” Sorting is excluded from this example’s timing; it does not establish an end-to-end benefit from sorting first.
- Do not spend the demo on runner controls or toolchain selection: the README identifies some of those settings as saved but not yet applied. The core workflow is sufficient for this pitch.

## Slide copy

**Slide 1 — Which version is actually faster?**

AI can write the code. You still need the experiment.

Build the benchmark · Isolate the work · Compare the evidence

**Slide 2 — Bench.it: turn a question into a measurement.**

1. Describe — Operation + input sizes
2. Generate — Inspectable benchmark code · Gemini
3. Measure — Connected hardware + visual results

Compare implementations · Investigate performance · Teach CPU behavior

## Implementation references used for this draft

- `frontend/src/model/examples.ts`: Array sum and sorted/random branch examples.
- `frontend/README.md`: translation, sweep execution, timed sections, counters, export, and current limitations.
- `frontend/src/bench/RunPanel.tsx`: progress and Open full results.
- `frontend/src/pages/Results.tsx`: relative comparisons, target snapshots, and CSV export.
- `proxy/README.md`: execution routing and available measurement fields.
