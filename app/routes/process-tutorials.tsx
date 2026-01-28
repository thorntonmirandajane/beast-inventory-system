import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useLoaderData, useActionData, Link, Form, useNavigation } from "react-router";
import { redirect } from "react-router";
import { requireUser, createAuditLog } from "../utils/auth.server";
import { Layout } from "../components/Layout";
import { ImageUpload } from "../components/ImageUpload";
import prisma from "../db.server";
import { useState } from "react";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const user = await requireUser(request);

  if (user.role !== "ADMIN") {
    throw new Response("Unauthorized", { status: 403 });
  }

  // Get all tutorials with their associated SKUs
  const tutorials = await prisma.processTutorial.findMany({
    where: { isActive: true },
    include: {
      skuTutorials: {
        include: {
          tutorial: {
            select: {
              id: true,
              processName: true,
            },
          },
        },
      },
    },
    orderBy: [{ processName: "asc" }, { createdAt: "desc" }],
  });

  // Get unique process names from database
  const uniqueProcesses = await prisma.sku.findMany({
    where: { material: { not: null }, isActive: true },
    select: { material: true },
    distinct: ["material"],
    orderBy: { material: "asc" },
  });

  // Get all active SKUs for the form
  const allSkus = await prisma.sku.findMany({
    where: { isActive: true },
    select: {
      id: true,
      sku: true,
      name: true,
      material: true,
      category: true,
    },
    orderBy: [{ material: "asc" }, { sku: "asc" }],
  });

  return {
    user,
    tutorials,
    uniqueProcesses: uniqueProcesses.map(p => p.material).filter(Boolean) as string[],
    allSkus,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const user = await requireUser(request);

  if (user.role !== "ADMIN") {
    return { error: "Unauthorized" };
  }

  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "create") {
    const processName = formData.get("processName") as string;
    const title = formData.get("title") as string;
    const description = formData.get("description") as string;
    const photoUrl = formData.get("photoUrl") as string;
    const skuIds = formData.getAll("skuIds") as string[];

    if (!processName || !title || !description) {
      return { error: "Process, title, and description are required" };
    }

    if (skuIds.length === 0) {
      return { error: "Please select at least one SKU" };
    }

    // Create tutorial
    const tutorial = await prisma.processTutorial.create({
      data: {
        processName,
        title,
        description,
        photoUrl: photoUrl || null,
        skuTutorials: {
          create: skuIds.map(skuId => ({ skuId })),
        },
      },
    });

    await createAuditLog(user.id, "CREATE_TUTORIAL", "ProcessTutorial", tutorial.id, {
      processName,
      skuCount: skuIds.length,
    });

    return { success: true, message: "Tutorial created successfully" };
  }

  if (intent === "delete") {
    const tutorialId = formData.get("tutorialId") as string;

    await prisma.processTutorial.update({
      where: { id: tutorialId },
      data: { isActive: false },
    });

    await createAuditLog(user.id, "DELETE_TUTORIAL", "ProcessTutorial", tutorialId, {});

    return { success: true, message: "Tutorial deleted successfully" };
  }

  if (intent === "update") {
    const tutorialId = formData.get("tutorialId") as string;
    const title = formData.get("title") as string;
    const description = formData.get("description") as string;
    const photoUrl = formData.get("photoUrl") as string;
    const skuIds = formData.getAll("skuIds") as string[];

    if (!title || !description) {
      return { error: "Title and description are required" };
    }

    if (skuIds.length === 0) {
      return { error: "Please select at least one SKU" };
    }

    // Delete existing SKU associations and recreate
    await prisma.processTutorialSku.deleteMany({
      where: { processTutorialId: tutorialId },
    });

    await prisma.processTutorial.update({
      where: { id: tutorialId },
      data: {
        title,
        description,
        photoUrl: photoUrl || null,
        skuTutorials: {
          create: skuIds.map(skuId => ({ skuId })),
        },
      },
    });

    await createAuditLog(user.id, "UPDATE_TUTORIAL", "ProcessTutorial", tutorialId, {
      skuCount: skuIds.length,
    });

    return { success: true, message: "Tutorial updated successfully" };
  }

  return { error: "Invalid action" };
};

export default function ProcessTutorials() {
  const { user, tutorials, uniqueProcesses, allSkus } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const [selectedProcess, setSelectedProcess] = useState("");
  const [selectedSkus, setSelectedSkus] = useState<string[]>([]);
  const [editingTutorial, setEditingTutorial] = useState<any>(null);
  const [photoUrl, setPhotoUrl] = useState("");

  // Filter SKUs by selected process
  const filteredSkus = selectedProcess
    ? allSkus.filter(sku => sku.material === selectedProcess)
    : allSkus;

  // Group tutorials by process
  const tutorialsByProcess = tutorials.reduce((acc, tutorial) => {
    if (!acc[tutorial.processName]) {
      acc[tutorial.processName] = [];
    }
    acc[tutorial.processName].push(tutorial);
    return acc;
  }, {} as Record<string, typeof tutorials>);

  const handleSkuToggle = (skuId: string) => {
    if (selectedSkus.includes(skuId)) {
      setSelectedSkus(selectedSkus.filter(id => id !== skuId));
    } else {
      setSelectedSkus([...selectedSkus, skuId]);
    }
  };

  const startEdit = (tutorial: any) => {
    setEditingTutorial(tutorial);
    setSelectedProcess(tutorial.processName);
    setPhotoUrl(tutorial.photoUrl || "");
    // Get SKU IDs from tutorial
    const skuIds = tutorial.skuTutorials.map((st: any) => st.skuId);
    setSelectedSkus(skuIds);
  };

  const cancelEdit = () => {
    setEditingTutorial(null);
    setSelectedProcess("");
    setSelectedSkus([]);
    setPhotoUrl("");
  };

  return (
    <Layout user={user}>
      <div className="page-header">
        <h1 className="page-title">Process Tutorials</h1>
        <p className="page-subtitle">Create tutorials to help workers learn processes</p>
      </div>

      {actionData?.error && (
        <div className="alert alert-error">{actionData.error}</div>
      )}
      {actionData?.success && (
        <div className="alert alert-success">{actionData.message}</div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Create/Edit Tutorial Form */}
        <div className="lg:col-span-1">
          <div className="card">
            <div className="card-header">
              <h2 className="card-title">
                {editingTutorial ? "Edit Tutorial" : "Create Tutorial"}
              </h2>
            </div>
            <div className="card-body">
              <Form method="post">
                <input
                  type="hidden"
                  name="intent"
                  value={editingTutorial ? "update" : "create"}
                />
                {editingTutorial && (
                  <input type="hidden" name="tutorialId" value={editingTutorial.id} />
                )}

                <div className="form-group">
                  <label className="form-label">Process *</label>
                  {editingTutorial ? (
                    <input
                      type="text"
                      className="form-input bg-gray-100"
                      value={editingTutorial.processName}
                      disabled
                    />
                  ) : (
                    <select
                      name="processName"
                      className="form-select"
                      required
                      value={selectedProcess}
                      onChange={(e) => {
                        setSelectedProcess(e.target.value);
                        setSelectedSkus([]);
                      }}
                    >
                      <option value="">Select a process...</option>
                      {uniqueProcesses.map(process => (
                        <option key={process} value={process}>
                          {process}
                        </option>
                      ))}
                    </select>
                  )}
                </div>

                <div className="form-group">
                  <label className="form-label">Tutorial Title *</label>
                  <input
                    type="text"
                    name="title"
                    className="form-input"
                    placeholder="e.g., How to Tip Ferrules"
                    required
                    defaultValue={editingTutorial?.title || ""}
                  />
                </div>

                <div className="form-group">
                  <label className="form-label">Description *</label>
                  <textarea
                    name="description"
                    className="form-textarea"
                    rows={6}
                    placeholder="Step-by-step instructions..."
                    required
                    defaultValue={editingTutorial?.description || ""}
                  />
                </div>

                <div className="form-group">
                  <ImageUpload
                    currentImageUrl={editingTutorial?.photoUrl || photoUrl}
                    onImageUploaded={(url) => setPhotoUrl(url)}
                    folder="tutorials"
                    label="Process Photo (Optional)"
                    helpText="Upload a photo showing the process steps"
                  />
                  <input type="hidden" name="photoUrl" value={photoUrl || editingTutorial?.photoUrl || ""} />
                </div>

                <div className="form-group">
                  <label className="form-label">
                    Select SKUs * ({selectedSkus.length} selected)
                  </label>
                  <div className="border rounded-lg p-3 max-h-64 overflow-y-auto space-y-2">
                    {filteredSkus.length === 0 ? (
                      <p className="text-sm text-gray-500 text-center py-4">
                        {selectedProcess
                          ? "No SKUs found for this process"
                          : "Select a process first"}
                      </p>
                    ) : (
                      filteredSkus.map(sku => (
                        <label
                          key={sku.id}
                          className="flex items-center gap-2 p-2 hover:bg-gray-50 rounded cursor-pointer"
                        >
                          <input
                            type="checkbox"
                            name="skuIds"
                            value={sku.id}
                            checked={selectedSkus.includes(sku.id)}
                            onChange={() => handleSkuToggle(sku.id)}
                            className="form-checkbox"
                          />
                          <div className="flex-1 min-w-0">
                            <div className="font-mono text-sm truncate">{sku.sku}</div>
                            <div className="text-xs text-gray-500 truncate">
                              {sku.name}
                            </div>
                          </div>
                        </label>
                      ))
                    )}
                  </div>
                </div>

                <div className="flex gap-2">
                  <button
                    type="submit"
                    className="btn btn-primary flex-1"
                    disabled={isSubmitting || selectedSkus.length === 0}
                  >
                    {isSubmitting
                      ? "Saving..."
                      : editingTutorial
                      ? "Update Tutorial"
                      : "Create Tutorial"}
                  </button>
                  {editingTutorial && (
                    <button
                      type="button"
                      onClick={cancelEdit}
                      className="btn btn-ghost"
                    >
                      Cancel
                    </button>
                  )}
                </div>
              </Form>
            </div>
          </div>
        </div>

        {/* Tutorial List */}
        <div className="lg:col-span-2">
          <div className="card">
            <div className="card-header">
              <h2 className="card-title">Existing Tutorials</h2>
            </div>
            <div className="card-body">
              {Object.keys(tutorialsByProcess).length === 0 ? (
                <div className="text-center py-8 text-gray-500">
                  <p>No tutorials created yet</p>
                  <p className="text-sm mt-2">Create your first tutorial using the form</p>
                </div>
              ) : (
                <div className="space-y-6">
                  {Object.entries(tutorialsByProcess).map(([processName, processTutorials]) => (
                    <div key={processName}>
                      <h3 className="font-semibold text-lg mb-3 text-blue-600">
                        {processName}
                      </h3>
                      <div className="space-y-3">
                        {processTutorials.map(tutorial => (
                          <div
                            key={tutorial.id}
                            className="border rounded-lg p-4 hover:shadow-md transition-shadow"
                          >
                            <div className="flex items-start justify-between gap-4">
                              <div className="flex-1">
                                <h4 className="font-semibold mb-2">{tutorial.title}</h4>
                                <p className="text-sm text-gray-600 mb-3 whitespace-pre-wrap">
                                  {tutorial.description}
                                </p>
                                {tutorial.photoUrl && (
                                  <div className="mb-3">
                                    <img
                                      src={tutorial.photoUrl}
                                      alt={tutorial.title}
                                      className="max-w-full h-auto rounded-lg max-h-64 object-contain"
                                    />
                                  </div>
                                )}
                                <div className="flex flex-wrap gap-2">
                                  {tutorial.skuTutorials.map((st: any) => {
                                    const sku = allSkus.find(s => s.id === st.skuId);
                                    return sku ? (
                                      <span
                                        key={st.id}
                                        className="badge bg-gray-100 text-gray-700 font-mono text-xs"
                                      >
                                        {sku.sku}
                                      </span>
                                    ) : null;
                                  })}
                                </div>
                              </div>
                              <div className="flex flex-col gap-2">
                                <button
                                  onClick={() => startEdit(tutorial)}
                                  className="btn btn-sm btn-secondary"
                                >
                                  Edit
                                </button>
                                <Form method="post">
                                  <input type="hidden" name="intent" value="delete" />
                                  <input type="hidden" name="tutorialId" value={tutorial.id} />
                                  <button
                                    type="submit"
                                    className="btn btn-sm btn-danger"
                                    onClick={(e) => {
                                      if (!confirm("Delete this tutorial?")) {
                                        e.preventDefault();
                                      }
                                    }}
                                  >
                                    Delete
                                  </button>
                                </Form>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </Layout>
  );
}
