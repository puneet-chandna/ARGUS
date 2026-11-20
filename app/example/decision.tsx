import { RunResult } from "../report";
import type { Example } from "../marketing/examples";

export function ExampleDecision({ example }: { example: Example }) {
  const { slug, title, report } = example;
  return <RunResult key={slug} readOnly run={{
    id: slug, filename: report.filename, checksum: report.checksum, created_at: "",
    display_name: title, revision: 0, status: "complete", result: report,
  }} />;
}
