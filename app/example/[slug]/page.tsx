import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { examples } from "../../marketing/examples";
import { ExampleDecision } from "../decision";

type Props = { params: Promise<{ slug: string }> };

export const dynamicParams = false;

export function generateStaticParams() {
  return examples.map(({ slug }) => ({ slug }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const example = examples.find(item => item.slug === slug);
  if (!example) return {};
  return {
    title: `${example.title} · Argus`,
    alternates: { canonical: `/example/${slug}` },
    robots: { index: true, follow: true },
  };
}

export default async function ExamplePage({ params }: Props) {
  const { slug } = await params;
  const example = examples.find(item => item.slug === slug);
  if (!example) notFound();
  return <ExampleDecision example={example} />;
}
