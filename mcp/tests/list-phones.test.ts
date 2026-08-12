import { describe, it, expect } from "vitest";
import { buildRows, countryOf } from "../src/tools/list-phones.js";

describe("countryOf", () => {
    it("splits +1 into US and CA by area code", () => {
        expect(countryOf("+13186330963")).toBe("US");
        expect(countryOf("+12184147420")).toBe("US");
        expect(countryOf("+14165550123")).toBe("CA");
    });

    it("resolves non-NANP dialling codes, longest prefix first", () => {
        expect(countryOf("+34600000000")).toBe("ES");
        expect(countryOf("+442071838750")).toBe("GB");
        expect(countryOf("+351911111111")).toBe("PT");
        expect(countryOf("+9999999999")).toBeNull();
    });
});

describe("buildRows", () => {
    const inventory = [
        { number: "+13186330963", name: "Florencia", agent: null },
        { number: "+12184147420", name: "(218) 414-7420", agent: "pres-pinecall" },
    ];

    it("reports the STORED owner, and free only when there is none", () => {
        const rows = buildRows(inventory, {}, {}, {});
        expect(rows[0]).toMatchObject({ number: "+13186330963", agent: null, live: false });
        expect(rows[1]).toMatchObject({ agent: "pres-pinecall", live: false });
    });

    it("an owner that is offline is still the owner — not free", () => {
        const rows = buildRows(inventory, { "+12184147420": "pres-pinecall" }, {}, {});
        expect(rows[1].agent).toBe("pres-pinecall");
        expect(rows[1].live).toBe(false);
    });

    it("marks the owner live when it is in the live routing map", () => {
        const rows = buildRows(inventory, {}, { "+12184147420": "pres-pinecall" }, {});
        expect(rows[1]).toMatchObject({ agent: "pres-pinecall", live: true });
    });

    it("names a dev override without losing the stored owner", () => {
        const rows = buildRows(inventory, {}, {}, { "+12184147420": "dev-probe" });
        expect(rows[1]).toMatchObject({ agent: "pres-pinecall", dev_override: "dev-probe", live: true });
    });

    it("keeps a routed number that is not in the inventory, flagged", () => {
        const rows = buildRows(inventory, {}, { "+34600111222": "soporte" }, {});
        const extra = rows.find((r) => r.number === "+34600111222")!;
        expect(extra).toMatchObject({ agent: "soporte", country: "ES", inInventory: false });
    });

    it("drops a name that is only the number reformatted, keeps a real one", () => {
        const rows = buildRows(inventory, {}, {}, {});
        expect(rows[0].name).toBe("Florencia");
        expect(rows[1].name).toBeUndefined();
    });
});
