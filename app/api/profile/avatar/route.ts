import { endpoint, HttpError, json, readJson } from "../../../../lib/http.ts";
import { profileStore } from "../../../../lib/profile.ts";
import { reviewer, serviceClient } from "../../../../lib/supabase.ts";

const MAX = 2_000_000;
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export const GET = endpoint(async () => {
  const { auth, user } = await reviewer();
  const photo = await profileStore(auth, user.id).avatar();
  if (!photo?.avatar_data || !photo.avatar_type) throw new HttpError(404, "No profile photo.");
  return new Response(Buffer.from(photo.avatar_data, "base64"), { headers: {
    "Content-Type": photo.avatar_type, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
  } });
});

export const PUT = endpoint(async (request) => {
  const { user } = await reviewer();
  const { image } = await readJson(request, Math.ceil(MAX / 3) * 4 + 128);
  if (typeof image !== "string") throw new HttpError(422, "Choose a PNG or JPG up to 2 MB.");
  const bytes = Buffer.from(image, "base64");
  const png = bytes.length >= 33 && bytes.subarray(0, 8).equals(PNG) && bytes.toString("ascii", 12, 16) === "IHDR";
  const jpeg = bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 &&
    bytes[bytes.length - 2] === 255 && bytes[bytes.length - 1] === 217;
  if (bytes.length > MAX || (!png && !jpeg)) throw new HttpError(422, "Choose a PNG or JPG up to 2 MB.");
  return json({ avatar_revision: await profileStore(serviceClient(), user.id).saveAvatar(png ? "image/png" : "image/jpeg", bytes.toString("base64")) });
});

export const DELETE = endpoint(async () => {
  const { user } = await reviewer();
  return json({ avatar_revision: await profileStore(serviceClient(), user.id).saveAvatar(null, null) });
});
