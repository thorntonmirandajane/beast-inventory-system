import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useLoaderData, useActionData, Form, Link, useNavigation } from "react-router";
import { redirect } from "react-router";
import { requireUser, createAuditLog } from "../utils/auth.server";
import { Layout } from "../components/Layout";
import prisma from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const user = await requireUser(request);

  // Get all SKUs for component selection
  const allSkus = await prisma.sku.findMany({
    where: { isActive: true },
    orderBy: [{ type: "asc" }, { sku: "asc" }],
  });

  return { user, allSkus };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const user = await requireUser(request);
  const formData = await request.formData();

  const sku = (formData.get("sku") as string)?.trim().toUpperCase();
  const name = (formData.get("name") as string)?.trim();
  const type = formData.get("type") as "RAW" | "ASSEMBLY" | "COMPLETED";
  const description = formData.get("description") as string;

  if (!sku || !name || !type) {
    return { error: "SKU, name, and type are required" };
  }

  // Check if SKU already exists
  const existing = await prisma.sku.findUnique({ where: { sku } });
  if (existing) {
    return { error: `SKU "${sku}" already exists` };
  }

  // Parse BOM components
  const components: { skuId: string; quantity: number }[] = [];
  let i = 0;
  while (formData.get(`components[${i}][skuId]`)) {
    const componentSkuId = formData.get(`components[${i}][skuId]`) as string;
    const quantity = parseInt(formData.get(`components[${i}][quantity]`) as string, 10);
    if (componentSkuId && quantity > 0) {
      components.push({ skuId: componentSkuId, quantity });
    }
    i++;
  }

  // Create SKU with BOM
  const newSku = await prisma.sku.create({
    data: {
      sku,
      name,
      type,
      description: description || null,
      bomComponents: {
        create: components.map((c) => ({
          componentSkuId: c.skuId,
          quantity: c.quantity,
        })),
      },
    },
  });

  await createAuditLog(user.id, "CREATE_SKU", "Sku", newSku.id, {
    sku,
    name,
    type,
    componentCount: components.length,
  });

  return redirect(`/skus/${newSku.id}`);
};

export default function NewSku() {
  const { user, allSkus } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const rawSkus = allSkus.filter((s) => s.type === "RAW");
  const assemblySkus = allSkus.filter((s) => s.type === "ASSEMBLY");

  return (
    <Layout user={user}>
      <div className="mb-6">
        <Link to="/skus" className="text-sm text-gray-500 hover:text-gray-700">
          ← Back to SKU Catalog
        </Link>
      </div>

      <div className="page-header">
        <h1 className="page-title">Create New SKU</h1>
        <p className="page-subtitle">Add a new product or component to the catalog</p>
      </div>

      {actionData?.error && (
        <div className="alert alert-error">{actionData.error}</div>
      )}

      <Form method="post">
        <div className="card mb-6">
          <div className="card-header">
            <h2 className="card-title">Basic Information</h2>
          </div>
          <div className="card-body">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="form-group">
                <label className="form-label">SKU Code *</label>
                <input
                  type="text"
                  name="sku"
                  className="form-input font-mono"
                  required
                  placeholder="e.g., FERRULE-100G"
                  style={{ textTransform: "uppercase" }}
                />
                <p className="text-sm text-gray-500 mt-1">
                  Unique identifier for this product
                </p>
              </div>
              <div className="form-group">
                <label className="form-label">Type *</label>
                <select name="type" className="form-select" required>
                  <option value="">Select type...</option>
                  <option value="RAW">Raw Material</option>
                  <option value="ASSEMBLY">Assembly (Intermediate)</option>
                  <option value="COMPLETED">Completed Product</option>
                </select>
                <p className="text-sm text-gray-500 mt-1">
                  Raw = purchased, Assembly = built intermediate, Completed = final product
                </p>
              </div>
              <div className="form-group md:col-span-2">
                <label className="form-label">Name *</label>
                <input
                  type="text"
                  name="name"
                  className="form-input"
                  required
                  placeholder="e.g., Titanium Ferrule - 100 Grain"
                />
              </div>
              <div className="form-group md:col-span-2">
                <label className="form-label">Description</label>
                <textarea
                  name="description"
                  className="form-textarea"
                  rows={2}
                  placeholder="Optional description..."
                />
              </div>
            </div>
          </div>
        </div>

        <div className="card mb-6">
          <div className="card-header">
            <h2 className="card-title">Bill of Materials (BOM)</h2>
            <p className="text-sm text-gray-500">
              For assemblies and completed products, specify what components are needed to build one unit
            </p>
          </div>
          <div className="card-body">
            <p className="text-sm text-gray-600 mb-4">
              Leave empty for raw materials. For assemblies/completed products, add the components required.
            </p>

            {rawSkus.length > 0 && (
              <div className="mb-6">
                <h3 className="font-medium text-gray-700 mb-2">Raw Materials</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                  {rawSkus.map((s, index) => (
                    <div key={s.id} className="flex items-center gap-2 p-2 bg-gray-50 rounded">
                      <input type="hidden" name={`components[${index}][skuId]`} value={s.id} />
                      <div className="flex-1 min-w-0">
                        <div className="font-mono text-sm truncate">{s.sku}</div>
                        <div className="text-xs text-gray-500 truncate">{s.name}</div>
                      </div>
                      <input
                        type="number"
                        name={`components[${index}][quantity]`}
                        className="form-input w-20 text-sm"
                        min="0"
                        defaultValue="0"
                        placeholder="Qty"
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}

            {assemblySkus.length > 0 && (
              <div>
                <h3 className="font-medium text-gray-700 mb-2">Assemblies</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                  {assemblySkus.map((s, index) => (
                    <div key={s.id} className="flex items-center gap-2 p-2 bg-blue-50 rounded">
                      <input
                        type="hidden"
                        name={`components[${rawSkus.length + index}][skuId]`}
                        value={s.id}
                      />
                      <div className="flex-1 min-w-0">
                        <div className="font-mono text-sm truncate">{s.sku}</div>
                        <div className="text-xs text-gray-500 truncate">{s.name}</div>
                      </div>
                      <input
                        type="number"
                        name={`components[${rawSkus.length + index}][quantity]`}
                        className="form-input w-20 text-sm"
                        min="0"
                        defaultValue="0"
                        placeholder="Qty"
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="flex gap-3">
          <button
            type="submit"
            className="btn btn-primary"
            disabled={isSubmitting}
          >
            {isSubmitting ? "Creating..." : "Create SKU"}
          </button>
          <Link to="/skus" className="btn btn-secondary">
            Cancel
          </Link>
        </div>
      </Form>
    </Layout>
  );
}
