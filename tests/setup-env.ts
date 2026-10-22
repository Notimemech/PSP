// Chạy trước mỗi file test: ghi đè env bằng giá trị giả, để code đọc env không bao giờ thấy giá trị thật.
import { TEST_ENV } from './helpers/test-env.js';

Object.assign(process.env, TEST_ENV);
