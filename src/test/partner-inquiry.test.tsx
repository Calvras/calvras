import { fireEvent, render, screen, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InquirySheet } from "@/components/CompanyPage";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function sheet() {
  const onClose = vi.fn();
  render(<InquirySheet onClose={onClose} />);
  return onClose;
}

describe("partner inquiry form", () => {
  it("offers the four collaboration options with one already picked", () => {
    sheet();
    expect(screen.getAllByRole("radio")).toHaveLength(4);
    expect(screen.getByRole("radio", { name: /Tools and integrations/ })).toBeChecked();
    expect(document.body.textContent).toContain("calvrasnoreply@gmail.com");
    expect(document.body.textContent).not.toContain("shikari");
  });

  it("refuses to compose a message out of an empty form", () => {
    sheet();
    fireEvent.click(screen.getByRole("link", { name: /Send inquiry/ }));
    expect(screen.getByRole("alert")).toHaveTextContent("Tell us who is writing");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("hands a complete inquiry to the mail client, addressed to calvrasnoreply", () => {
    sheet();
    fireEvent.click(screen.getByRole("radio", { name: /Education and communities/ }));
    fireEvent.change(screen.getByPlaceholderText("Who you are"), { target: { value: "Ada" } });
    fireEvent.change(screen.getByPlaceholderText("you@company.com"), { target: { value: "ada@school.org" } });
    fireEvent.change(screen.getByPlaceholderText(/The product or community/), { target: { value: "We run a 400-member developer meetup and want a workshop track." } });
    fireEvent.click(screen.getByRole("link", { name: /Send inquiry/ }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    const url = decodeURIComponent(screen.getByRole("link", { name: /Send inquiry/ }).getAttribute("href") || "");
    expect(url).toContain("mailto:calvrasnoreply@gmail.com");
    expect(url).toContain("Education and communities");
    expect(url).toContain("ada@school.org");
    expect(url).toContain("400-member developer meetup");
    expect(screen.getByRole("status").textContent).toContain("calvrasnoreply@gmail.com");
  });

  it("closes on Escape", () => {
    const onClose = sheet();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
