import { notFound } from "next/navigation";
import Argus from "../../argus";
import { profilePaths, type ProfileSection } from "../../../lib/profile-settings";

export default async function ProfilePage({ params }: { params: Promise<{ section?: string[] }> }) {
  const { section = [] } = await params;
  if (section.length > 1 || (section.length === 1 && (section[0] === "account" || !Object.hasOwn(profilePaths, section[0])))) notFound();
  return <Argus initialView="profile" section={(section[0] ?? "account") as ProfileSection} />;
}
