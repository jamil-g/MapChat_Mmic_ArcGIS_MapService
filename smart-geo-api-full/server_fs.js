// Simulated ArcGIS FeatureService using Google Sheets + Express + OpenAI
require('dotenv').config();
require('events').EventEmitter.defaultMaxListeners = 50; // Add at the top of server.js
const express = require('express');
const { google } = require('googleapis');
const bodyParser = require('body-parser');
const cors = require('cors');
const turf = require('@turf/turf');
const NodeCache = require("node-cache");
const { OpenAI } = require("openai");
const fetch = require('node-fetch');
const interpretCache = new NodeCache({ stdTTL: 60 }); // cache interpreted queries

const sheetCache = new NodeCache({ stdTTL: 60 }); // cache for 5 seconds
const app = express();
const PORT = process.env.PORT || 3000;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.use(cors());
app.use(bodyParser.json());

const SHEET_ID = '1YdkA4i_v_t54hetZ7uQlZAevZmuDLiqjjQBu6GgNWKs';
const RANGE_LATEST = 'natural_data!A2:E';
const RANGE_PREVIOUS = 'previous!A2:E';

const auth = new google.auth.GoogleAuth({
  keyFile: 'credentials.json',
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});

async function getSheetClient() {
  const authClient = await auth.getClient();
  return google.sheets({ version: 'v4', auth: authClient });
}

function projectToWebMercator([x, y]) {
  const RADIUS = 6378137;
  const rad = Math.PI / 180;
  return [
    RADIUS * x * rad,
    RADIUS * Math.log(Math.tan(Math.PI / 4 + y * rad / 2))
  ];
}

function toEsriFeature([id, name, geometry, type, year], index) {
  const geom = JSON.parse(geometry);
  let rings = [];

  if (geom.type === 'Polygon') {
    rings = geom.coordinates.map(ring => ring.map(projectToWebMercator));
  } else if (geom.type === 'MultiPolygon') {
    rings = geom.coordinates.flat().map(ring => ring.map(projectToWebMercator));
  } else {
    console.warn(`Unsupported geometry type: ${geom.type}`);
  }

  return {
    attributes: {
      oid: index + 1,
      id,
      name,
      type,
      year: parseInt(year),
      change: null
    },
    geometry: {
      rings,
      spatialReference: { wkid: 102100 }
    }
  };
}

function toGeoJSONFeature([id, name, geometry, type, year]) {
  return {
    type: 'Feature',
    geometry: JSON.parse(geometry),
    properties: { id, name, type, year: parseInt(year) }
  };
}

app.get('/FeatureServer/0', (req, res) => {
  res.json({
    id: 0,
    type: 'Feature Layer',
    name: 'Simulated Parcels',
    geometryType: 'esriGeometryPolygon',
    objectIdField: 'oid',
    supportsQuery: true,
    capabilities: 'Create,Delete,Query,Update,Editing',
    fields: [
      { name: 'oid', type: 'esriFieldTypeOID', alias: 'Object ID' },
      { name: 'id', type: 'esriFieldTypeString', alias: 'ID' },
      { name: 'name', type: 'esriFieldTypeString', alias: 'Name' },
      { name: 'type', type: 'esriFieldTypeString', alias: 'Type' },
      { name: 'year', type: 'esriFieldTypeInteger', alias: 'Year' },
      { name: 'change', type: 'esriFieldTypeString', alias: 'Change' }
    ],
    drawingInfo: {
      renderer: {
        type: 'simple',
        symbol: {
          type: 'esriSFS',
          style: 'esriSFSSolid',
          color: [255, 255, 204, 128],
          outline: { color: [0, 0, 0, 255], width: 1 }
        }
      }
    },
    extent: {
      xmin: 949555.26,
      ymin: 6001034.48,
      xmax: 951781.65,
      ymax: 6004321.82,
      spatialReference: { wkid: 102100 }
    },
    spatialReference: { wkid: 102100 }
  });
});

app.get('/FeatureServer', (req, res) => {
  res.json({
    currentVersion: 10.91,
    serviceDescription: "Simulated FeatureService from Google Sheets",
    hasVersionedData: false,
    supportsDisconnectedEditing: false,
    hasStaticData: false,
    maxRecordCount: 1000,
    supportedQueryFormats: "JSON",
    capabilities: "Query",
    description: "Test layer",
    copyrightText: "OpenAI + Jamil :)",
    spatialReference: { wkid: 102100 },
    initialExtent: {
      xmin: 949555.26, ymin: 6001034.48,
      xmax: 951781.65, ymax: 6004321.82,
      spatialReference: { wkid: 102100 }
    },
    fullExtent: {
      xmin: -20037508.34,
      ymin: -20037508.34,
      xmax: 20037508.34,
      ymax: 20037508.34,
      spatialReference: { wkid: 102100 }
    },
    layers: [
      { id: 0, name: "Simulated Parcels", parentLayerId: -1, defaultVisibility: true, subLayerIds: null, minScale: 0, maxScale: 0 }
    ],
    tables: []
  });
});

app.post('/FeatureServer/0/interpret', async (req, res) => {
  const { query } = req.body;
  if (!query) return res.status(400).json({ error: 'Missing query' });

  const cached = interpretCache.get(query);
  if (cached) {
    return res.json({ interpreted: cached });
  }

  try {
    const chatResponse = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [
        {
		  role: 'system',
		  content: `You are a GIS assistant. Convert user natural-language queries into SQL-like 'where' clauses supported by ArcGIS Feature Services.
	Only use fields: type (e.g., 'park', 'garden'), year (e.g., 2023), and change (text like "Area changed by 15.2%").
	Examples:
	- "Show only parks" => "type = 'park'"
	- "Parks after 2021" => "type = 'park' AND year > 2021"
	- "Features that changed more than 10%" => "change LIKE '%10%'"
	Return only the expression without any explanation.`
			},
			{ role: 'user', content: query }
		  ],
		  temperature: 0.2
		});

		const where = chatResponse.choices[0].message.content.trim();
		interpretCache.set(query, where);
		console.log (`AI query ${query} generate ${where}`);
		return res.json({ interpreted: where });

	  } catch (err) {
		console.error('🛑 Error in interpret:', err);
		return res.status(500).json({ error: 'Interpretation failed' });
	  }
	});


app.get('/FeatureServer/0/query', async (req, res) => {
  const { where = '', outFields = '*', f = 'json', geometry, resultType } = req.query;

  // OPTIONAL: Ignore tile queries (or return empty if needed)
  /*const now = Date.now();
  if (resultType === 'tile' && now - lastFetch < 2000) {
	console.warn("🔁 Too frequent tile request, skipping...");
	return res.json({ features: [], ... });
  }
  lastFetch = now;*/

  // Use cached features (not just raw rows)
  let features = sheetCache.get('parsedFeatures');

  // Refresh from Sheets if not cached
  if (!features) {
    const sheet = await getSheetClient();
    const [latestRows, previousRows] = await Promise.all([
      sheet.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: RANGE_LATEST }),
      sheet.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: RANGE_PREVIOUS }),
    ]);


    const latest = Object.fromEntries((latestRows.data.values || []).map(r => [r[0], toGeoJSONFeature(r)]));
    const previous = Object.fromEntries((previousRows.data.values || []).map(r => [r[0], toGeoJSONFeature(r)]));

    features = (latestRows.data.values || []).map((row, index) => {
      const feature = toEsriFeature(row, index);
      const id = feature.attributes.id;

      if (latest[id] && previous[id]) {
        try {
          const diff = turf.difference(
            turf.polygon(latest[id].geometry.coordinates),
            turf.polygon(previous[id].geometry.coordinates)
          );
          if (diff) {
            const areaA = turf.area(latest[id]);
            const areaB = turf.area(previous[id]);
            const delta = ((areaA - areaB) / areaB) * 100;
            feature.attributes.change = `Area changed by ${delta.toFixed(1)}%`;
          }
        } catch (e) {
          // skip diff errors
        }
      }

      return feature;
    });

    // Cache parsed features
    sheetCache.set('parsedFeatures', features);
  }

  // Apply filter logic
  const normalizedWhere = where.replace(/\s+/g, ' ').trim().toLowerCase();
  const filtered = features.filter(feature => {
  const { type, year, change } = feature.attributes;
  const clause = where.toLowerCase().trim();

  if (clause === '1=1') return true;

  const checks = [];

  // Match type = 'value'
  const typeRegex = /type\s*=\s*'([^']+)'/;
  const typeMatch = clause.match(typeRegex);
  if (typeMatch) {
    checks.push(type?.toLowerCase() === typeMatch[1].toLowerCase());
  }

  // Match year >=, <=, >, <, = number
  const yearRegex = /year\s*(>=|<=|=|<|>)\s*(\d+)/g;
  let yearMatch;
  while ((yearMatch = yearRegex.exec(clause)) !== null) {
    const operator = yearMatch[1];
    const value = parseInt(yearMatch[2]);
    switch (operator) {
      case '>': checks.push(year > value); break;
      case '<': checks.push(year < value); break;
      case '=': checks.push(year === value); break;
      case '>=': checks.push(year >= value); break;
      case '<=': checks.push(year <= value); break;
    }
  }

  // Match change LIKE '%value%'
  const changeRegex = /change\s+like\s+'%?(.+?)%?'/;
  const changeMatch = clause.match(changeRegex);
  if (changeMatch) {
    const keyword = changeMatch[1].toLowerCase();
    checks.push(change?.toLowerCase().includes(keyword));
  }

  return checks.every(Boolean);
})


  res.json({
    objectIdFieldName: 'oid',
    geometryType: 'esriGeometryPolygon',
    spatialReference: { wkid: 102100 },
    fields: [
      { name: 'oid', type: 'esriFieldTypeOID' },
      { name: 'id', type: 'esriFieldTypeString' },
      { name: 'name', type: 'esriFieldTypeString' },
      { name: 'type', type: 'esriFieldTypeString' },
      { name: 'year', type: 'esriFieldTypeInteger' },
      { name: 'change', type: 'esriFieldTypeString' }
    ],
    features: filtered
  });
});


app.listen(PORT, () => console.log(`🚀 Simulated FeatureService listening on port ${PORT}`));