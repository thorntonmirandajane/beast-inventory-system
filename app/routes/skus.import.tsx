import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useLoaderData, useActionData, Form, useNavigation } from "react-router";
import { requireUser, createAuditLog } from "../utils/auth.server";
import { Layout } from "../components/Layout";
import prisma from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const user = await requireUser(request);

  if (user.role !== "ADMIN") {
    throw new Response("Unauthorized", { status: 403 });
  }

  return { user };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const user = await requireUser(request);

  if (user.role !== "ADMIN") {
    return { error: "Unauthorized" };
  }

  const formData = await request.formData();
  const csvFile = formData.get("csvFile") as File;

  if (!csvFile || csvFile.size === 0) {
    return { error: "Please select a CSV file" };
  }

  try {
    const text = await csvFile.text();
    const lines = text.split("\n").filter((line) => line.trim());

    if (lines.length < 2) {
      return { error: "CSV file is empty or invalid" };
    }

    // Skip header row
    const dataLines = lines.slice(1);

    let created = 0;
    let updated = 0;
    const errors: string[] = [];

    for (let i = 0; i < dataLines.length; i++) {
      const line = dataLines[i];
      const values = parseCsvLine(line);

      if (values.length < 7) {
        errors.push(`Line ${i + 2}: Not enough columns`);
        continue;
      }

      const [
        skuCode,
        name,
        type,
        category,
        material,
        description,
        isActiveStr,
      ] = values;

      if (!skuCode || !name || !type) {
        errors.push(`Line ${i + 2}: Missing required fields (SKU, Name, or Type)`);
        continue;
      }

      const isActive = isActiveStr?.toLowerCase() === "yes" || isActiveStr?.toLowerCase() === "true";

      // Check if type is valid
      if (!["RAW", "ASSEMBLY", "COMPLETED"].includes(type)) {
        errors.push(`Line ${i + 2}: Invalid type "${type}". Must be RAW, ASSEMBLY, or COMPLETED`);
        continue;
      }

      try {
        // Check if SKU exists
        const existing = await prisma.sku.findUnique({
          where: { sku: skuCode },
        });

        if (existing) {
          // Update existing
          await prisma.sku.update({
            where: { sku: skuCode },
            data: {
              name,
              type,
              category: category || null,
              material: material || null,
              description: description || null,
              isActive,
            },
          });
          updated++;

          await createAuditLog(user.id, "UPDATE_SKU", "Sku", existing.id, {
            source: "import",
            skuCode,
          });
        } else {
          // Create new
          const newSku = await prisma.sku.create({
            data: {
              sku: skuCode,
              name,
              type,
              category: category || null,
              material: material || null,
              description: description || null,
              isActive,
            },
          });
          created++;

          await createAuditLog(user.id, "CREATE_SKU", "Sku", newSku.id, {
            source: "import",
            skuCode,
          });
        }
      } catch (error) {
        errors.push(`Line ${i + 2}: ${error instanceof Error ? error.message : "Unknown error"}`);
      }
    }

    if (errors.length > 0 && created === 0 && updated === 0) {
      return { error: `Import failed:\n${errors.join("\n")}` };
    }

    return {
      success: true,
      message: `Import complete: ${created} created, ${updated} updated${errors.length > 0 ? `, ${errors.length} errors` : ""}`,
      errors: errors.length > 0 ? errors : undefined,
    };
  } catch (error) {
    return {
      error: `Failed to process CSV: ${error instanceof Error ? error.message : "Unknown error"}`,
    };
  }
};

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        // Escaped quote
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      values.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }

  values.push(current.trim());
  return values;
}

export default function SkuImport() {
  const { user } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  return (
    <Layout user={user}>
      <div className="page-header">
        <h1 className="page-title">Import SKUs</h1>
        <p className="page-subtitle">
          Upload a CSV file to create or update SKUs in bulk
        </p>
      </div>

      {actionData?.error && (
        <div className="alert alert-error whitespace-pre-line">{actionData.error}</div>
      )}
      {actionData?.success && (
        <div className="alert alert-success">
          {actionData.message}
          {actionData.errors && actionData.errors.length > 0 && (
            <details className="mt-2">
              <summary className="cursor-pointer font-semibold">
                View {actionData.errors.length} error(s)
              </summary>
              <ul className="mt-2 text-sm list-disc list-inside">
                {actionData.errors.map((error, i) => (
                  <li key={i}>{error}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      <div className="card mb-6">
        <div className="card-header">
          <h2 className="card-title">CSV Format</h2>
        </div>
        <div className="card-body">
          <p className="text-sm text-gray-700 mb-3">
            Your CSV file should have the following columns (in order):
          </p>
          <ol className="list-decimal list-inside text-sm space-y-1 mb-4">
            <li>
              <strong>SKU</strong> (required) - Unique SKU code
            </li>
            <li>
              <strong>Name</strong> (required) - SKU name/description
            </li>
            <li>
              <strong>Type</strong> (required) - RAW, ASSEMBLY, or COMPLETED
            </li>
            <li>
              <strong>Category</strong> (optional) - TIPPING, BLADING,
              STUD_TESTING, or COMPLETE_PACKS
            </li>
            <li>
              <strong>Material</strong> (optional) - TITANIUM, ALUMINUM, STEEL,
              STAINLESS, CARBON, or OTHER
            </li>
            <li>
              <strong>Description</strong> (optional)
            </li>
            <li>
              <strong>Is Active</strong> (optional) - Yes/No or True/False
              (default: Yes)
            </li>
          </ol>
          <div className="bg-gray-50 p-3 rounded border text-xs font-mono overflow-x-auto">
            SKU,Name,Type,Category,Material,Description,Is Active
            <br />
            2IN-100G-BEAST,BROADHEAD- 2.0 IN CUT - 100
            GR,COMPLETED,COMPLETE_PACKS,TITANIUM,2 inch broadhead 100
            grain,Yes
            <br />
            FERRULE-2IN,Ferrule 2 inch,RAW,,TITANIUM,Raw ferrule
            material,Yes
          </div>
          <p className="text-sm text-gray-500 mt-3">
            <strong>Note:</strong> If a SKU already exists, it will be updated.
            Otherwise, a new SKU will be created. Inventory levels and BOM
            components are not imported - use the individual SKU pages to manage
            those.
          </p>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <h2 className="card-title">Upload CSV</h2>
        </div>
        <div className="card-body">
          <Form method="post" encType="multipart/form-data">
            <div className="form-group">
              <label className="form-label">Select CSV File</label>
              <input
                type="file"
                name="csvFile"
                accept=".csv,text/csv"
                className="form-input"
                required
              />
            </div>
            <div className="flex gap-3">
              <button
                type="submit"
                className="btn btn-primary"
                disabled={isSubmitting}
              >
                {isSubmitting ? "Importing..." : "Import SKUs"}
              </button>
              <a href="/skus" className="btn btn-secondary">
                Cancel
              </a>
            </div>
          </Form>
        </div>
      </div>
    </Layout>
  );
}
