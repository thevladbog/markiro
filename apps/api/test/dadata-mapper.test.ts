import { describe, expect, it } from "vitest";

import {
  mapDadataAddressSuggestions,
  mapDadataBankSuggestions,
  mapDadataOrganizationSuggestions,
} from "../src/integrations/dadata/dadata.mapper";

describe("DaData mapper", () => {
  it("maps a minimized organization fixture without retaining provider fields", () => {
    const mapped = mapDadataOrganizationSuggestions({
      suggestions: [
        {
          value: "ООО РОМАШКА",
          unrestricted_value: "ООО РОМАШКА",
          data: {
            type: "LEGAL",
            inn: "7700000000",
            kpp: "770001001",
            ogrn: "1027700000000",
            hid: "provider-only-id",
            name: {
              full_with_opf: "Общество с ограниченной ответственностью Ромашка",
              short_with_opf: "ООО Ромашка",
            },
            address: {
              value: "г Москва, ул Тверская, д 1",
              data: {
                fias_id: "fias-address-id",
                kladr_id: "7700000000000",
                postal_code: "125009",
                region_with_type: "г Москва",
                city_with_type: "г Москва",
                street_with_type: "ул Тверская",
                house: "1",
                geo_lat: "55.757",
                geo_lon: "37.615",
                qc: "0",
                qc_complete: "10",
              },
            },
          },
        },
      ],
      provider_meta: { token: "must-not-survive" },
    });

    expect(mapped).toEqual([
      {
        value: "ООО РОМАШКА",
        kind: "legal_entity",
        fullName: "Общество с ограниченной ответственностью Ромашка",
        displayName: "ООО Ромашка",
        inn: "7700000000",
        kpp: "770001001",
        ogrn: "1027700000000",
        ogrnip: null,
        legalAddress: {
          value: "г Москва, ул Тверская, д 1",
          fiasId: "fias-address-id",
          kladrId: "7700000000000",
          postalCode: "125009",
          region: "г Москва",
          city: "г Москва",
          settlement: null,
          street: "ул Тверская",
          house: "1",
          block: null,
          flat: null,
          latitude: "55.757",
          longitude: "37.615",
          qualityCode: "0",
          completenessCode: "10",
        },
      },
    ]);
    expect(JSON.stringify(mapped)).not.toMatch(/provider|hid|token/i);
  });

  it("maps missing address components and bank correspondent data to null", () => {
    expect(
      mapDadataAddressSuggestions({
        suggestions: [{ value: "г Казань", data: { region_with_type: "Респ Татарстан" } }],
      }),
    ).toEqual([
      {
        value: "г Казань",
        fiasId: null,
        kladrId: null,
        postalCode: null,
        region: "Респ Татарстан",
        city: null,
        settlement: null,
        street: null,
        house: null,
        block: null,
        flat: null,
        latitude: null,
        longitude: null,
        qualityCode: null,
        completenessCode: null,
      },
    ]);
    expect(
      mapDadataBankSuggestions({
        suggestions: [
          {
            value: "ПАО Сбербанк",
            data: { bic: "044525225", correspondent_account: null, name: { payment: null } },
          },
        ],
      }),
    ).toEqual([
      {
        value: "ПАО Сбербанк",
        bic: "044525225",
        bankName: "ПАО Сбербанк",
        correspondentAccount: null,
      },
    ]);
  });
});
