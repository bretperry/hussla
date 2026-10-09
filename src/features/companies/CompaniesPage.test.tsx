/*
  Component test for the companies table: clicking a column header sorts, and compare needs two to four picks.
  In the app: nothing at runtime; guards the table sort and the compare button's rules.
  Used by: pnpm test.
*/
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@/shared/api";
import { companySummaries } from "@/test/fixtures";
import { CompaniesPage } from "./CompaniesPage";

afterEach(() => vi.restoreAllMocks());

const firstColumn = () => screen.getAllByRole("row").slice(1).map((row) => within(row).getAllByRole("cell")[1]?.textContent);

describe("CompaniesPage", () => {
  it("sorts by a column on click, and reverses on a second click", async () => {
    vi.spyOn(api, "listCompanies").mockResolvedValue(companySummaries);
    const user = userEvent.setup();
    render(<CompaniesPage />);
    await waitFor(() => expect(firstColumn()).toHaveLength(4));
    expect(firstColumn()[0]).toBe("Northwind Labs");
    await user.click(screen.getByRole("button", { name: "Company" }));
    expect(firstColumn()).toEqual(["Contoso Payments", "Fabrikam Cloud", "Northwind Labs", "Tailspin Data"]);
    await user.click(screen.getByRole("button", { name: /^Company/ }));
    expect(firstColumn()).toEqual(["Tailspin Data", "Northwind Labs", "Fabrikam Cloud", "Contoso Payments"]);
  });

  it("enables Compare at two picks and stops at four", async () => {
    vi.spyOn(api, "listCompanies").mockResolvedValue([...companySummaries, { ...companySummaries[0] ?? fail(), slug: "fifth", name: "Fifth Co" }]);
    const user = userEvent.setup();
    render(<CompaniesPage />);
    await screen.findByLabelText("Compare Northwind Labs");
    expect(screen.getByRole("button", { name: "Compare" })).toBeDisabled();
    await user.click(screen.getByLabelText("Compare Northwind Labs"));
    await user.click(screen.getByLabelText("Compare Fabrikam Cloud"));
    expect(screen.getByRole("button", { name: "Compare (2)" })).toBeEnabled();
    await user.click(screen.getByLabelText("Compare Contoso Payments"));
    await user.click(screen.getByLabelText("Compare Tailspin Data"));
    expect(screen.getByLabelText("Compare Fifth Co")).toBeDisabled();
  });
});

const fail = (): never => {
  throw new Error("fixture missing");
};
