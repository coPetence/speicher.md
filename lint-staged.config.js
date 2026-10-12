module.exports = {
  '*.{ts,js,json,md,mdx,css,yaml,yml}': ['prettier --write'],
  '{src,test}/**/*.ts': ['eslint --max-warnings=0'],
};
