import type { Metadata } from "next";
import { examples } from "../marketing/examples";
import { ExampleDecision } from "./decision";

export const metadata: Metadata = {
  title: "Example decisions · Argus",
  description: "Inspect the rates, policy facts, and rate-card evidence for four synthetic motor policies.",
  alternates: { canonical: "/example" },
  robots: { index: true, follow: true },
};

export default function ExamplesPage() {
  return <ExampleDecision example={examples[0]} />;
}
