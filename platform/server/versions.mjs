// Versions a lab can pin (plan-master task 19.3): the environment, and the
// grading rules. Task set versions live on each TaskSet. All three go into
// every environment response's info. The canary is in every task file and
// export so contamination of public training data can be detected later.
export const ENVIRONMENT_VERSION = '1.0.0';
export const GRADING_VERSION = '1.0.0';
export const CANARY = 'hospital-desktop-canary-7f3a9c-v1';
export const ENV_PROTOCOL = 'openenv-http/1';
