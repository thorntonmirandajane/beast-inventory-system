import { v2 as cloudinary } from "cloudinary";

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

/**
 * Upload image to Cloudinary from a base64 string or file buffer
 * @param file - base64 string or Buffer
 * @param folder - folder name in Cloudinary (e.g., "quality-control", "tutorials")
 * @returns Cloudinary URL of the uploaded image
 */
export async function uploadImage(
  file: string | Buffer,
  folder: string = "beast-inventory"
): Promise<{ url: string; publicId: string }> {
  try {
    const result = await cloudinary.uploader.upload(
      typeof file === "string" ? file : `data:image/jpeg;base64,${file.toString("base64")}`,
      {
        folder: `beast-inventory/${folder}`,
        resource_type: "image",
        transformation: [
          { width: 1200, height: 1200, crop: "limit" }, // Max size
          { quality: "auto" }, // Auto quality
          { fetch_format: "auto" }, // Auto format (WebP if supported)
        ],
      }
    );

    return {
      url: result.secure_url,
      publicId: result.public_id,
    };
  } catch (error) {
    console.error("Cloudinary upload error:", error);
    throw new Error("Failed to upload image to Cloudinary");
  }
}

/**
 * Delete image from Cloudinary
 * @param publicId - The public ID of the image to delete
 */
export async function deleteImage(publicId: string): Promise<void> {
  try {
    await cloudinary.uploader.destroy(publicId);
  } catch (error) {
    console.error("Cloudinary delete error:", error);
    throw new Error("Failed to delete image from Cloudinary");
  }
}

/**
 * Get Cloudinary upload widget configuration for client-side uploads
 */
export function getCloudinaryConfig() {
  return {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME,
    uploadPreset: "beast_inventory_unsigned", // You'll need to create this in Cloudinary dashboard
  };
}

export { cloudinary };
