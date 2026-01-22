import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useLoaderData, useActionData, Form, useNavigation } from "react-router";
import { requireRole, createAuditLog, hashPassword } from "../utils/auth.server";
import { Layout } from "../components/Layout";
import prisma from "../db.server";
import type { UserRole } from "@prisma/client";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const user = await requireRole(request, ["ADMIN"]);

  const users = await prisma.user.findMany({
    orderBy: [{ role: "asc" }, { lastName: "asc" }, { firstName: "asc" }],
  });

  return { user, users };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const user = await requireRole(request, ["ADMIN"]);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "create") {
    const email = formData.get("email") as string;
    const password = formData.get("password") as string;
    const firstName = formData.get("firstName") as string;
    const lastName = formData.get("lastName") as string;
    const role = formData.get("role") as UserRole;
    const payRateStr = formData.get("payRate") as string;

    if (!email || !password || !firstName || !lastName || !role) {
      return { error: "All fields are required" };
    }

    const existing = await prisma.user.findUnique({
      where: { email: email.toLowerCase() },
    });

    if (existing) {
      return { error: "Email already exists" };
    }

    const hashedPassword = await hashPassword(password);
    const payRate = payRateStr ? parseFloat(payRateStr) : null;

    const newUser = await prisma.user.create({
      data: {
        email: email.toLowerCase(),
        password: hashedPassword,
        firstName,
        lastName,
        role,
        payRate,
      },
    });

    await createAuditLog(user.id, "CREATE_USER", "User", newUser.id, {
      email: newUser.email,
      role: newUser.role,
      payRate,
    });

    return { success: true, message: `User ${firstName} ${lastName} created` };
  }

  if (intent === "update") {
    const userId = formData.get("userId") as string;
    const role = formData.get("role") as UserRole;
    const isActive = formData.get("isActive") === "true";
    const payRateStr = formData.get("payRate") as string;
    const payRate = payRateStr ? parseFloat(payRateStr) : null;

    await prisma.user.update({
      where: { id: userId },
      data: { role, isActive, payRate },
    });

    await createAuditLog(user.id, "UPDATE_USER", "User", userId, {
      role,
      isActive,
      payRate,
    });

    return { success: true, message: "User updated" };
  }

  if (intent === "resetPassword") {
    const userId = formData.get("userId") as string;
    const newPassword = formData.get("newPassword") as string;

    if (!newPassword || newPassword.length < 6) {
      return { error: "Password must be at least 6 characters" };
    }

    const hashedPassword = await hashPassword(newPassword);

    await prisma.user.update({
      where: { id: userId },
      data: { password: hashedPassword },
    });

    await createAuditLog(user.id, "RESET_PASSWORD", "User", userId, {});

    return { success: true, message: "Password reset successfully" };
  }

  return { error: "Invalid action" };
};

export default function Users() {
  const { user, users } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const roles: UserRole[] = ["ADMIN", "WORKER"];

  const getRoleColor = (role: UserRole) => {
    switch (role) {
      case "ADMIN":
        return "bg-purple-100 text-purple-800";
      case "WORKER":
        return "bg-gray-100 text-gray-800";
      default:
        return "bg-gray-100 text-gray-800";
    }
  };

  return (
    <Layout user={user}>
      <div className="page-header">
        <h1 className="page-title">User Management</h1>
        <p className="page-subtitle">Manage system users and permissions</p>
      </div>

      {actionData?.error && (
        <div className="alert alert-error">{actionData.error}</div>
      )}
      {actionData?.success && (
        <div className="alert alert-success">{actionData.message}</div>
      )}

      {/* Create User Form */}
      <div className="card mb-6">
        <div className="card-header">
          <h2 className="card-title">Create New User</h2>
        </div>
        <div className="card-body">
          <Form method="post">
            <input type="hidden" name="intent" value="create" />
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              <div className="form-group mb-0">
                <label className="form-label">First Name *</label>
                <input
                  type="text"
                  name="firstName"
                  className="form-input"
                  required
                  placeholder="First name"
                />
              </div>
              <div className="form-group mb-0">
                <label className="form-label">Last Name *</label>
                <input
                  type="text"
                  name="lastName"
                  className="form-input"
                  required
                  placeholder="Last name"
                />
              </div>
              <div className="form-group mb-0">
                <label className="form-label">Email *</label>
                <input
                  type="email"
                  name="email"
                  className="form-input"
                  required
                  placeholder="email@example.com"
                />
              </div>
              <div className="form-group mb-0">
                <label className="form-label">Password *</label>
                <input
                  type="password"
                  name="password"
                  className="form-input"
                  required
                  minLength={6}
                  placeholder="Min 6 characters"
                />
              </div>
              <div className="form-group mb-0">
                <label className="form-label">Role *</label>
                <select name="role" className="form-select" required>
                  {roles.map((role) => (
                    <option key={role} value={role}>
                      {role}
                    </option>
                  ))}
                </select>
              </div>
              <div className="form-group mb-0">
                <label className="form-label">Pay Rate ($/hr)</label>
                <input
                  type="number"
                  name="payRate"
                  className="form-input"
                  placeholder="Hourly rate"
                  step="0.01"
                  min="0"
                />
              </div>
            </div>
            <div className="mt-4">
              <button
                type="submit"
                className="btn btn-primary"
                disabled={isSubmitting}
              >
                {isSubmitting ? "Creating..." : "Create User"}
              </button>
            </div>
          </Form>
        </div>
      </div>

      {/* Users Table */}
      <div className="card">
        <div className="card-header">
          <h2 className="card-title">All Users ({users.length})</h2>
        </div>
        <table className="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Role</th>
              <th className="text-right">Pay Rate</th>
              <th>Status</th>
              <th>Created</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className={!u.isActive ? "opacity-50" : ""}>
                <td className="font-medium">
                  {u.firstName} {u.lastName}
                </td>
                <td>{u.email}</td>
                <td>
                  <span className={`badge ${getRoleColor(u.role)}`}>{u.role}</span>
                </td>
                <td className="text-right">
                  {u.payRate ? (
                    <span className="font-medium text-green-600">${u.payRate.toFixed(2)}/hr</span>
                  ) : (
                    <span className="text-gray-400">—</span>
                  )}
                </td>
                <td>
                  <span
                    className={`badge ${
                      u.isActive ? "status-approved" : "status-rejected"
                    }`}
                  >
                    {u.isActive ? "Active" : "Inactive"}
                  </span>
                </td>
                <td>{new Date(u.createdAt).toLocaleDateString()}</td>
                <td>
                  {u.id !== user.id && (
                    <div className="space-y-2">
                      {/* Update Role/Status/Pay Rate */}
                      <Form method="post" className="flex items-center gap-2">
                        <input type="hidden" name="intent" value="update" />
                        <input type="hidden" name="userId" value={u.id} />
                        <select
                          name="role"
                          className="form-select text-sm py-1.5 px-2 w-28"
                          defaultValue={u.role}
                        >
                          {roles.map((role) => (
                            <option key={role} value={role}>
                              {role}
                            </option>
                          ))}
                        </select>
                        <select
                          name="isActive"
                          className="form-select text-sm py-1.5 px-2 w-24"
                          defaultValue={u.isActive.toString()}
                        >
                          <option value="true">Active</option>
                          <option value="false">Inactive</option>
                        </select>
                        <input
                          type="number"
                          name="payRate"
                          className="form-input text-sm py-1.5 px-2 w-24"
                          placeholder="$/hr"
                          step="0.01"
                          min="0"
                          defaultValue={u.payRate || ""}
                        />
                        <button
                          type="submit"
                          className="btn btn-sm btn-secondary"
                          disabled={isSubmitting}
                        >
                          Save
                        </button>
                      </Form>

                      {/* Reset Password */}
                      <Form method="post" className="flex items-center gap-2">
                        <input type="hidden" name="intent" value="resetPassword" />
                        <input type="hidden" name="userId" value={u.id} />
                        <input
                          type="password"
                          name="newPassword"
                          className="form-input text-sm py-1.5 px-2 w-32"
                          placeholder="New password"
                          minLength={6}
                        />
                        <button
                          type="submit"
                          className="btn btn-sm btn-ghost text-blue-600"
                          disabled={isSubmitting}
                        >
                          Reset Password
                        </button>
                      </Form>
                    </div>
                  )}
                  {u.id === user.id && (
                    <span className="text-sm text-gray-400 italic">(Current user)</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Layout>
  );
}
