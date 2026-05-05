import { useState, useRef } from "react";

interface MultiImageUploadProps {
  name: string;
  initialUrls?: string[];
  folder?: string;
  label?: string;
  helpText?: string;
  onChange?: (urls: string[]) => void;
}

export function MultiImageUpload({
  name,
  initialUrls = [],
  folder = "general",
  label = "Upload Images",
  helpText = "Click to upload one or more images. Max 5MB each.",
  onChange,
}: MultiImageUploadProps) {
  const [urls, setUrls] = useState<string[]>(initialUrls);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const updateUrls = (next: string[]) => {
    setUrls(next);
    onChange?.(next);
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;

    for (const file of files) {
      if (file.size > 5 * 1024 * 1024) {
        setError(`"${file.name}" is larger than 5MB`);
        return;
      }
      if (!file.type.startsWith("image/")) {
        setError(`"${file.name}" is not an image`);
        return;
      }
    }

    setError(null);
    setUploading(true);

    const uploaded: string[] = [];
    try {
      for (const file of files) {
        const base64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result as string);
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });

        const formData = new FormData();
        formData.append("intent", "upload-image");
        formData.append("image", base64);
        formData.append("folder", folder);

        const response = await fetch("/api/upload-image", {
          method: "POST",
          body: formData,
        });
        const data = await response.json();
        if (data.error) {
          setError(data.error);
          break;
        }
        uploaded.push(data.url);
      }

      if (uploaded.length > 0) {
        updateUrls([...urls, ...uploaded]);
      }
    } catch (err) {
      console.error("Upload error:", err);
      setError("Failed to upload one or more images");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const removeAt = (idx: number) => {
    updateUrls(urls.filter((_, i) => i !== idx));
  };

  const inputId = `multi-upload-${name}`;

  return (
    <div className="space-y-2">
      <label className="form-label">
        {label} {urls.length > 0 && <span className="text-gray-500">({urls.length})</span>}
      </label>

      {urls.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
          {urls.map((url, idx) => (
            <div key={url} className="relative border rounded-lg overflow-hidden bg-gray-50">
              <img src={url} alt={`Upload ${idx + 1}`} className="w-full h-32 object-cover" />
              <button
                type="button"
                onClick={() => removeAt(idx)}
                className="absolute top-1 right-1 bg-red-600 text-white rounded-full w-6 h-6 flex items-center justify-center text-sm hover:bg-red-700"
                aria-label="Remove image"
                disabled={uploading}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="border-2 border-dashed border-gray-300 rounded-lg p-4 text-center hover:border-gray-400 transition-colors">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          onChange={handleFileChange}
          className="hidden"
          id={inputId}
          disabled={uploading}
        />
        <label htmlFor={inputId} className="cursor-pointer">
          <p className="text-sm text-gray-600">
            {uploading ? "Uploading..." : helpText}
          </p>
          <p className="text-xs text-gray-500 mt-1">PNG, JPG, GIF up to 5MB each</p>
        </label>
      </div>

      {error && <div className="text-red-600 text-sm">{error}</div>}

      {urls.map((url) => (
        <input key={url} type="hidden" name={name} value={url} />
      ))}
    </div>
  );
}
