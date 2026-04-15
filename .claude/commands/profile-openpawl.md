# /profile-openpawl

Quick performance check on OpenPawl.

Usage: /profile-openpawl [scenario]

## Arguments

$ARGUMENTS

## Steps

1. Parse scenario from arguments (default: solo)
2. Run with profiling:
   ```bash
   OPENPAWL_PROFILE=true OPENPAWL_DEBUG=true openpawl run --headless \
     --mode <scenario> --goal "Build hello world Express server" \
     --workdir ~/personal/openpawl-test-projects/profile-check
   ```
3. Read profile report: `cat ~/.openpawl/profile-report.md`
4. Read debug timing: `openpawl logs debug --source llm --timeline`
5. Report: total time, LLM time, tool time, memory time, bottleneck
6. Compare against baseline if exists
