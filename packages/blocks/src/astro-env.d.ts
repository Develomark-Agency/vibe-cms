// For type-checking this package on its own; Astro projects get the real types from `astro/client`.
declare module "*.astro" {
  const component: (props: any) => unknown;
  export default component;
}
