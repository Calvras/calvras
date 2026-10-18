import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthScreen, LaunchGate, SplashScreen } from "../components/LaunchScreen";

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

describe("launch screen", () => {
  it("shows only the logo on the splash while the app starts", () => {
    render(<SplashScreen />);
    expect(screen.getByRole("status", { name: "Calvras is starting" })).toBeInTheDocument();
    expect(screen.getByAltText("Calvras")).toBeInTheDocument();
    expect(screen.queryByText("CALVRAS")).not.toBeInTheDocument();
    expect(screen.queryByText("Built for what’s next")).not.toBeInTheDocument();
  });

  it("signs in with the account Google hands back", async () => {
    Object.defineProperty(window, "__electron", { value: { googleSignIn: async () => ({ ok: true, email: "hello@calvras.com", name: "Shikari" }) }, configurable: true });
    const onContinue = vi.fn();
    render(<AuthScreen onContinue={onContinue} />);
    fireEvent.click(screen.getByRole("button", { name: "Continue with Google" }));
    expect(screen.getByText("Signing in…")).toBeInTheDocument();
    await waitFor(() => expect(onContinue).toHaveBeenCalledWith(expect.objectContaining({ provider: "google", email: "hello@calvras.com", name: "Shikari" })));
  });

  it("refuses to pretend Google signed in when the desktop bridge is not there", async () => {
    Object.defineProperty(window, "__electron", { value: undefined, configurable: true });
    const onContinue = vi.fn();
    render(<AuthScreen onContinue={onContinue} />);
    fireEvent.click(screen.getByRole("button", { name: "Continue with Google" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Google sign-in runs in the Calvras desktop app."));
    expect(onContinue).not.toHaveBeenCalled();
  });

  it("says so when the user walks away from the browser", async () => {
    Object.defineProperty(window, "__electron", { value: { googleSignIn: async () => ({ ok: false, error: "Google sign-in was cancelled." }) }, configurable: true });
    const onContinue = vi.fn();
    render(<AuthScreen onContinue={onContinue} />);
    fireEvent.click(screen.getByRole("button", { name: "Continue with Google" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Google sign-in was cancelled."));
    expect(screen.getByRole("button", { name: "Continue with Google" })).toBeEnabled();
    expect(onContinue).not.toHaveBeenCalled();
  });

  it("offers Google and nothing else — no email field, no code, no send request", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<AuthScreen onContinue={vi.fn()} />);
    expect(screen.queryByLabelText("Email")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Sign-in code")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Continue with email/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/Check your email/)).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Continue with Google" })).toBeInTheDocument();
  });

  it("gives the desktop sign-in window its own controls", () => {
    Object.defineProperty(window, "__electron", { value: { minimize: vi.fn(), maximize: vi.fn(), close: vi.fn(), isMaximized: async () => false }, configurable: true });
    render(<AuthScreen onContinue={vi.fn()} />);
    for (const label of ["Minimize", "Maximize", "Close"]) expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
  });

  it("shows no window controls in a browser, where there is no window to control", () => {
    Object.defineProperty(window, "__electron", { value: undefined, configurable: true });
    render(<AuthScreen onContinue={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Close" })).not.toBeInTheDocument();
  });

  it("links the legal sentence to the real pages and drops the tagline", () => {
    render(<AuthScreen onContinue={vi.fn()} />);
    expect(screen.queryByText(/Sign in to keep your projects/)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "terms" })).toHaveAttribute("href", "https://calvras.com/terms");
    expect(screen.getByRole("link", { name: "privacy policy" })).toHaveAttribute("href", "https://calvras.com/privacy");
  });

  it("holds the splash for two seconds, then asks for sign-in", () => {
    vi.useFakeTimers();
    render(<LaunchGate><p>Workspace ready</p></LaunchGate>);
    expect(screen.getByRole("status", { name: "Calvras is starting" })).toBeInTheDocument();
    expect(screen.queryByText("Workspace ready")).not.toBeInTheDocument();
    advance(1999);
    expect(screen.getByRole("status", { name: "Calvras is starting" })).toBeInTheDocument();
    advance(1);
    expect(screen.getByRole("button", { name: "Continue with Google" })).toBeInTheDocument();
    expect(screen.queryByText("Workspace ready")).not.toBeInTheDocument();
  });

  it("enters the workspace after Google sign-in and remembers the session", async () => {
    Object.defineProperty(window, "__electron", { value: { googleSignIn: async () => ({ ok: true, email: "hello@calvras.com", name: "Shikari" }) }, configurable: true });
    vi.useFakeTimers();
    render(<LaunchGate><p>Workspace ready</p></LaunchGate>);
    advance(2000);
    vi.useRealTimers();
    fireEvent.click(screen.getByRole("button", { name: "Continue with Google" }));
    await waitFor(() => expect(screen.getByText("Workspace ready")).toBeInTheDocument());
    expect(JSON.parse(String(localStorage.getItem("calvras_user")))).toMatchObject({ provider: "google" });
    expect(sessionStorage.getItem("calvras_session_started")).toBe("1");
  });

  it("skips the splash for an already started session", () => {
    sessionStorage.setItem("calvras_session_started", "1");
    localStorage.setItem("calvras_user", JSON.stringify({ provider: "google", joinedAt: 1 }));
    render(<LaunchGate><p>Workspace ready</p></LaunchGate>);
    expect(screen.getByText("Workspace ready")).toBeInTheDocument();
  });
});
