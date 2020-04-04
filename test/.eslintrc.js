/** @type import('eslint').Linter.Config */
module.exports = {
  env: {
    browser: true, // /root/.eslintrc.jsでtrueになってるので，明示的にfalseにする
    node: true,
    jest: true,
  },
};
