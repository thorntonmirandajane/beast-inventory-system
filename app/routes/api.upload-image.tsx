import type { ActionFunctionArgs } from "react-router";
import { json } from "react-router";
import { requireUser } from "../utils/auth.server";
import { uploadImage } from "../utils/cloudinary.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    const user = await requireUser(request);

    const formData = await request.formData();
    const imageBase64 = formData.get("image") as string;
    const folder = formData.get("folder") as string || "general";

    if (!imageBase64) {
      return json({ error: "No image provided" }, { status: 400 });
    }

    // Upload to Cloudinary
    const { url, publicId } = await uploadImage(imageBase64, folder);

    return json({ url, publicId, success: true });
  } catch (error) {
    console.error("Image upload error:", error);
    return json(
      { error: error instanceof Error ? error.message : "Failed to upload image" },
      { status: 500 }
    );
  }
};
