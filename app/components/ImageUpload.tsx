import { useState, useRef } from "react";
import { useFetcher } from "react-router";

interface ImageUploadProps {
  currentImageUrl?: string | null;
  onImageUploaded?: (url: string) => void;
  folder?: string;
  label?: string;
  helpText?: string;
}

export function ImageUpload({
  currentImageUrl,
  onImageUploaded,
  folder = "general",
  label = "Upload Image",
  helpText = "Click to upload or drag and drop. Max 5MB.",
}: ImageUploadProps) {
  const [preview, setPreview] = useState<string | null>(currentImageUrl || null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const fetcher = useFetcher();

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Validate file size (5MB max)
    if (file.size > 5 * 1024 * 1024) {
      setError("File size must be less than 5MB");
      return;
    }

    // Validate file type
    if (!file.type.startsWith("image/")) {
      setError("File must be an image");
      return;
    }

    setError(null);
    setUploading(true);

    try {
      // Convert to base64
      const reader = new FileReader();
      reader.onloadend = async () => {
        const base64String = reader.result as string;
        setPreview(base64String);

        // Upload to Cloudinary via API route
        const formData = new FormData();
        formData.append("intent", "upload-image");
        formData.append("image", base64String);
        formData.append("folder", folder);

        const response = await fetch("/api/upload-image", {
          method: "POST",
          body: formData,
        });

        const data = await response.json();

        if (data.error) {
          setError(data.error);
          setPreview(currentImageUrl || null);
        } else {
          setPreview(data.url);
          if (onImageUploaded) {
            onImageUploaded(data.url);
          }
        }

        setUploading(false);
      };

      reader.readAsDataURL(file);
    } catch (err) {
      console.error("Upload error:", err);
      setError("Failed to upload image");
      setUploading(false);
      setPreview(currentImageUrl || null);
    }
  };

  const handleRemoveImage = () => {
    setPreview(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
    if (onImageUploaded) {
      onImageUploaded("");
    }
  };

  return (
    <div className="space-y-2">
      <label className="form-label">{label}</label>

      {preview ? (
        <div className="relative border rounded-lg p-4 bg-gray-50">
          <img
            src={preview}
            alt="Preview"
            className="max-w-full h-auto rounded max-h-96 mx-auto"
          />
          <button
            type="button"
            onClick={handleRemoveImage}
            className="absolute top-2 right-2 btn btn-sm bg-red-600 text-white hover:bg-red-700"
            disabled={uploading}
          >
            Remove
          </button>
          {uploading && (
            <div className="absolute inset-0 bg-black bg-opacity-50 flex items-center justify-center rounded">
              <div className="text-white font-semibold">Uploading...</div>
            </div>
          )}
        </div>
      ) : (
        <div className="border-2 border-dashed border-gray-300 rounded-lg p-8 text-center hover:border-gray-400 transition-colors">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={handleFileChange}
            className="hidden"
            id="image-upload"
          />
          <label htmlFor="image-upload" className="cursor-pointer">
            <svg
              className="mx-auto h-12 w-12 text-gray-400"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
              />
            </svg>
            <p className="mt-2 text-sm text-gray-600">{helpText}</p>
            <p className="mt-1 text-xs text-gray-500">PNG, JPG, GIF up to 5MB</p>
          </label>
        </div>
      )}

      {error && (
        <div className="text-red-600 text-sm">{error}</div>
      )}

      {uploading && (
        <div className="text-blue-600 text-sm">Uploading image...</div>
      )}

      {/* Hidden input to store the URL for form submission */}
      {preview && <input type="hidden" name="imageUrl" value={preview} />}
    </div>
  );
}
