/// <reference types="vite/client" />

declare module '*.geojson' {
  const value: GeoJSON.FeatureCollection;
  export default value;
}
