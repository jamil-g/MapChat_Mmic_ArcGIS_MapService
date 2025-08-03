const fs = require("fs");
const { google } = require("googleapis");

function esriToGeoJSONGeometry(feature, geometryType) {
  if (geometryType === "esriGeometryPolygon" && feature.geometry?.rings) {
    return {
      type: "Polygon",
      coordinates: feature.geometry.rings
    };
  }
  if (geometryType === "esriGeometryPolyline" && feature.geometry?.paths) {
    return {
      type: "LineString",
      coordinates: feature.geometry.paths[0]
    };
  }
  if (geometryType === "esriGeometryPoint" && feature.geometry?.x !== undefined && feature.geometry?.y !== undefined) {
    return {
      type: "Point",
      coordinates: [feature.geometry.x, feature.geometry.y]
    };
  }
  return null;
}

async function uploadToGoogleSheetsInBatches(rows, spreadsheetId, batchSize = 100) {
  const auth = new google.auth.GoogleAuth({
    keyFile: "credentials.json",
    scopes: ["https://www.googleapis.com/auth/spreadsheets"]
  });
  const sheets = google.sheets({ version: "v4", auth });

  // Upload header first
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: "natural_data!A1",
    valueInputOption: "RAW",
    requestBody: { values: [rows[0]] }
  });

  // Upload in smaller batches
  for (let i = 1; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const range = `natural_data!A${i + 1}`;
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range,
      valueInputOption: "RAW",
      requestBody: { values: batch }
    });
    console.log(`✅ Uploaded rows ${i + 1} to ${i + batch.length}`);
  }
}

(async () => {
  const esriJSON = JSON.parse(fs.readFileSync("natural_sw.json", "utf8"));

  if (!Array.isArray(esriJSON.features)) {
    throw new Error("❌ No features array found in file — make sure this is ArcGIS JSON.");
  }

  const geometryType = esriJSON.geometryType;
  const fields = esriJSON.fields.map(f => f.name);

   const header = [...fields, "Geometry"];
   const dataRows = esriJSON.features.map(f => {
    const attrVals = fields.map(field => f.attributes[field]);
    const geom = esriToGeoJSONGeometry(f, geometryType);
    return [
      ...attrVals,
      geom ? JSON.stringify(geom) : ""
    ];
  });

  const rows = [header, ...dataRows];
  const spreadsheetId = '1YdkA4i_v_t54hetZ7uQlZAevZmuDLiqjjQBu6GgNWKs';
  //const range = "natural_data!A1";
  await uploadToGoogleSheetsInBatches(rows, spreadsheetId, 100);
})();
