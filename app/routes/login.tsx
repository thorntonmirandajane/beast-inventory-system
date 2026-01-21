import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, redirect, useActionData, useNavigation } from "react-router";
import { getUser, login, createAuthCookie } from "../utils/auth.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const user = await getUser(request);
  if (user) {
    return redirect("/");
  }
  return {};
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const formData = await request.formData();
  const email = formData.get("email") as string;
  const password = formData.get("password") as string;

  if (!email || !password) {
    return { error: "Email and password are required" };
  }

  const result = await login(email, password);

  if (!result.success || !result.token) {
    return { error: result.error || "Login failed" };
  }

  return redirect("/", {
    headers: {
      "Set-Cookie": createAuthCookie(result.token),
    },
  });
};

export default function Login() {
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  return (
    <div className="login-container">
      <div className="login-card">
        <h1 className="login-logo">BEAST</h1>
        <p className="login-subtitle">Inventory Management System</p>

        {actionData?.error && (
          <div className="alert alert-error">{actionData.error}</div>
        )}

        <Form method="post">
          <div className="form-group">
            <label htmlFor="email" className="form-label">
              Email
            </label>
            <input
              type="email"
              id="email"
              name="email"
              className="form-input"
              placeholder="you@example.com"
              required
              autoFocus
            />
          </div>

          <div className="form-group">
            <label htmlFor="password" className="form-label">
              Password
            </label>
            <input
              type="password"
              id="password"
              name="password"
              className="form-input"
              placeholder="••••••••"
              required
            />
          </div>

          <button
            type="submit"
            className="btn btn-primary w-full mt-6"
            disabled={isSubmitting}
          >
            {isSubmitting ? "Signing in..." : "Sign in"}
          </button>
        </Form>

        <p className="text-center text-sm text-gray-500 mt-6">
          Default: admin@beast.com / admin123
        </p>
      </div>
    </div>
  );
}
