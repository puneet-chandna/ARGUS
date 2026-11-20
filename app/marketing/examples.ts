import type { Run, Source } from "../report";
import digit from "../../submission/pvt-car-satp-go-digit.json";
import hdfc from "../../submission/pvt-car-comprehensive-hdfc-ergo.json";
import reliance from "../../submission/pvt-car-comprehensive-reliance.json";
import tata from "../../submission/pvt-car-satp-tata-aig.json";

const fixtures = [
  { slug: "go-digit", name: "Go Digit", coverage: "Stand-alone TP", report: digit },
  { slug: "hdfc-ergo", name: "HDFC ERGO", coverage: "Comprehensive", report: hdfc },
  { slug: "reliance", name: "Reliance", coverage: "Comprehensive", report: reliance },
  { slug: "tata-aig", name: "Tata AIG", coverage: "Stand-alone TP", report: tata },
] as const;

export const examples = fixtures.map(({ report, ...fixture }) => ({
  ...fixture,
  // The submission JSON is the published snapshot under its original rule version.
  report: report as NonNullable<Run["result"]> & { filename: string; checksum: string },
  title: `${fixture.name} · ${fixture.coverage}`,
}));

export type Example = typeof examples[number];

export function gridCitation(example: Example) {
  const step = example.report.trace.findLast(item => item.sources.some(source => source.sheet || source.row));
  return step?.sources.findLast(source => source.sheet || source.row);
}

export function citationLabel(source: Source) {
  return source.sheet ? `${source.sheet}${source.cells ? `!${source.cells}` : ""}` :
    `Page ${source.page} · ${source.row ?? source.file}`;
}

export const previews = examples.map(example => {
  const { slug, name, coverage, report } = example;
  const part = report.tp.rate != null || !report.od.applicable ? report.tp : report.od;
  const citation = gridCitation(example);
  const fields = ["rto", "fuel", "engine_cc", "model", "current_ncb"].flatMap(key => {
    const fact = report.fields[key];
    const page = fact?.evidence.find(source => source.page)?.page;
    return fact?.value == null ? [] : [{ key, value: String(fact.value), page }];
  }).slice(0, 3);
  return {
    slug, name, coverage, filename: report.fields.insurer?.evidence[0]?.file,
    fields, status: report.status, rate: part.rate,
    reason: slug === "hdfc-ergo" ? "Confirm eligible private-car GWP to select the Zone 2 OD slab." : part.reason,
    unsupported: part !== report.tp && report.tp.status === "unsupported" ? report.tp.reason : null,
    component: part === report.tp ? "Third-party brokerage" : "Own-damage brokerage",
    other: part === report.tp && report.od.applicable === false ? "OD inapplicable" : null,
    citation: citation && { text: citationLabel(citation), file: citation.file },
  };
});
