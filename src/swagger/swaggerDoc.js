const swaggerDocument = {
  openapi: '3.0.0',
  info: {
    title: 'ADMS Backend API',
    version: '1.0.0',
    description: 'Swagger documentation for the ADMS backend authentication API.',
  },
  servers: [
    {
      url: 'https://192.168.193.68:5000/api',
      description: 'Local backend server',
    },
  ],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
      },
    },
    schemas: {
      LoginRequest: {
        type: 'object',
        required: ['username', 'password'],
        properties: {
          username: { type: 'string' },
          password: { type: 'string' },
        },
      },
      RegisterRequest: {
        type: 'object',
        required: ['username', 'password'],
        properties: {
          username: { type: 'string' },
          password: { type: 'string' },
          full_name: { type: 'string' },
          email: { type: 'string', format: 'email' },
          phone_number: { type: 'string' },
          department: { type: 'string' },
          role: { type: 'string' },
          location: { type: 'string' },
          manager: { type: 'string' },
          employee_id: { type: 'string' },
          join_date: { type: 'string', format: 'date' },
        },
      },
      ChangePasswordRequest: {
        type: 'object',
        required: ['currentPassword', 'newPassword'],
        properties: {
          currentPassword: { type: 'string' },
          newPassword: { type: 'string' },
        },
      },
      RequestPasswordReset: {
        type: 'object',
        required: ['email'],
        properties: {
          email: { type: 'string', format: 'email' },
        },
      },
      ResetPasswordRequest: {
        type: 'object',
        required: ['token', 'newPassword'],
        properties: {
          token: { type: 'string' },
          newPassword: { type: 'string' },
        },
      },
      UserProfile: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          username: { type: 'string' },
          full_name: { type: 'string' },
          email: { type: 'string', format: 'email' },
          phone_number: { type: 'string' },
          department: { type: 'string' },
          role: { type: 'string' },
          is_admin: { type: 'boolean' },
          location: { type: 'string' },
          manager: { type: 'string' },
          employee_id: { type: 'string' },
          join_date: { type: 'string', format: 'date' },
          bio: { type: 'string' },
          profile_photo_url: { type: 'string', format: 'uri' },
        },
      },
      UpdateProfileRequest: {
        type: 'object',
        properties: {
          full_name: { type: 'string' },
          email: { type: 'string', format: 'email' },
          phone_number: { type: 'string' },
          department: { type: 'string' },
          role: { type: 'string' },
          location: { type: 'string' },
          manager: { type: 'string' },
          employee_id: { type: 'string' },
          join_date: { type: 'string', format: 'date' },
          bio: { type: 'string' },
          profile_photo_url: { type: 'string', format: 'uri' },
        },
      },
      Document: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          title: { type: 'string' },
          description: { type: 'string' },
          original_filename: { type: 'string' },
          mime_type: { type: 'string' },
          size_bytes: { type: 'integer' },
          storage_key: { type: 'string' },
          thumbnail_key: { type: 'string' },
          folder_id: { type: 'string' },
          checksum: { type: 'string' },
          uploaded_by: { type: 'integer' },
          uploaded_at: { type: 'string', format: 'date-time' },
          acknowledgement_required: { type: 'boolean' },
          acknowledgement_count: { type: 'integer' },
          acknowledged_at: { type: 'string', format: 'date-time', nullable: true },
        },
      },
      UserSummary: {
        type: 'object',
        properties: {
          id: { type: 'integer' }, username: { type: 'string' }, full_name: { type: 'string' },
          email: { type: 'string', format: 'email' }, role: { type: 'string' }, is_admin: { type: 'boolean' },
        },
      },
      AdminStatusRequest: {
        type: 'object', required: ['is_admin'], properties: { is_admin: { type: 'boolean' } },
      },
      DocumentPermission: {
        type: 'object', required: ['user_id'], properties: {
          user_id: { type: 'integer' }, view: { type: 'boolean' }, download: { type: 'boolean' },
          upload: { type: 'boolean' }, edit: { type: 'boolean' }, delete_permission: { type: 'boolean' },
          share: { type: 'boolean' }, copy: { type: 'boolean' },
        },
      },
      Acknowledgement: {
        type: 'object', properties: {
          user_id: { type: 'integer' }, full_name: { type: 'string' }, username: { type: 'string' },
          email: { type: 'string', format: 'email' }, signed_at: { type: 'string', format: 'date-time' },
        },
      },
      DocumentListResponse: {
        type: 'object',
        properties: {
          documents: { type: 'array', items: { $ref: '#/components/schemas/Document' } },
          totalCount: { type: 'integer' },
          page: { type: 'integer' },
          pageSize: { type: 'integer' },
        },
      },
      Folder: {
        type: 'object',
        properties: {
          folder_key: { type: 'string' },
          name: { type: 'string' },
          description: { type: 'string' },
          parent_folder_key: { type: 'string' },
          count: { type: 'integer' },
        },
      },
      CreateFolderRequest: {
        type: 'object',
        required: ['name'],
        properties: {
          folder_key: { type: 'string' },
          name: { type: 'string' },
          description: { type: 'string' },
          parent_folder_key: { type: 'string' },
        },
      },
      DeleteManyRequest: {
        type: 'object',
        required: ['ids'],
        properties: {
          ids: {
            type: 'array',
            items: { type: 'integer' },
          },
        },
      },
      DeleteManyResponse: {
        type: 'object',
        properties: {
          deletedIds: { type: 'array', items: { type: 'integer' } },
          missingIds: { type: 'array', items: { type: 'integer' } },
          message: { type: 'string' },
        },
      },
      UploadResponse: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          title: { type: 'string' },
          original_filename: { type: 'string' },
          folder_id: { type: 'string' },
        },
      },
      UploadManyResponse: {
        type: 'object',
        properties: {
          count: { type: 'integer' },
          documents: { type: 'array', items: { $ref: '#/components/schemas/Document' } },
        },
      },
      GalleryItem: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          title: { type: 'string' },
          description: { type: 'string' },
          original_filename: { type: 'string' },
          mime_type: { type: 'string' },
          size_bytes: { type: 'integer' },
          storage_key: { type: 'string' },
          thumbnail_key: { type: 'string' },
          folder_id: { type: 'string' },
          checksum: { type: 'string' },
          uploaded_by: { type: 'integer' },
          uploaded_at: { type: 'string', format: 'date-time' },
        },
      },
      GalleryItemListResponse: {
        type: 'object',
        properties: {
          items: { type: 'array', items: { $ref: '#/components/schemas/GalleryItem' } },
          totalCount: { type: 'integer' },
          page: { type: 'integer' },
          pageSize: { type: 'integer' },
        },
      },
      GalleryFolder: {
        type: 'object',
        properties: {
          folder_key: { type: 'string' },
          name: { type: 'string' },
          description: { type: 'string' },
          parent_folder_key: { type: 'string' },
          count: { type: 'integer' },
        },
      },
      CreateGalleryFolderRequest: {
        type: 'object',
        required: ['name'],
        properties: {
          folder_key: { type: 'string' },
          name: { type: 'string' },
          description: { type: 'string' },
          parent_folder_key: { type: 'string' },
        },
      },
      GalleryUploadManyResponse: {
        type: 'object',
        properties: {
          count: { type: 'integer' },
          items: { type: 'array', items: { $ref: '#/components/schemas/GalleryItem' } },
        },
      },
    },
  },
  paths: {
    '/auth/login': {
      post: {
        tags: ['Auth'],
        summary: 'Log in with username and password',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/LoginRequest' },
            },
          },
        },
        responses: {
          '200': {
            description: 'Successful login',
          },
          '400': { description: 'Missing username or password' },
          '401': { description: 'Invalid credentials' },
        },
      },
    },
    '/auth/register': {
      post: {
        tags: ['Auth'],
        summary: 'Register a new user',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/RegisterRequest' },
            },
          },
        },
        responses: {
          '201': { description: 'User created' },
          '400': { description: 'Missing username or password' },
          '409': { description: 'Username already exists' },
        },
      },
    },
    '/auth/change-password': {
      post: {
        tags: ['Auth'],
        summary: 'Change password for authenticated user',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ChangePasswordRequest' },
            },
          },
        },
        responses: {
          '200': { description: 'Password changed successfully' },
          '400': { description: 'Missing password fields' },
          '401': { description: 'Invalid current password or missing token' },
          '404': { description: 'User not found' },
        },
      },
    },
    '/auth/profile': {
      get: {
        tags: ['Auth'],
        summary: 'Get authenticated user profile',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': {
            description: 'Profile retrieved successfully',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    user: { $ref: '#/components/schemas/UserProfile' },
                  },
                },
              },
            },
          },
          '401': { description: 'Authorization required' },
          '404': { description: 'User not found' },
        },
      },
      put: {
        tags: ['Auth'],
        summary: 'Update authenticated user profile',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/UpdateProfileRequest' },
            },
          },
        },
        responses: {
          '200': {
            description: 'Profile updated successfully',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    user: { $ref: '#/components/schemas/UserProfile' },
                  },
                },
              },
            },
          },
          '400': { description: 'Invalid profile payload' },
          '401': { description: 'Authorization required' },
          '404': { description: 'User not found' },
        },
      },
    },
    '/auth/request-password-reset': {
      post: {
        tags: ['Auth'],
        summary: 'Request a password reset token and send a reset link to email',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/RequestPasswordReset' },
            },
          },
        },
        responses: {
          '200': { description: 'If email exists, a reset link is sent' },
          '400': { description: 'Email is required' },
        },
      },
    },
    '/auth/reset-password': {
      post: {
        tags: ['Auth'],
        summary: 'Reset password using a token provided via email',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ResetPasswordRequest' },
            },
          },
        },
        responses: {
          '200': { description: 'Password reset successfully' },
          '400': { description: 'Invalid or expired token' },
        },
      },
    },
    '/auth/refresh-token': {
      post: {
        tags: ['Auth'],
        summary: 'Refresh access token using refresh token',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['refreshToken'],
                properties: {
                  refreshToken: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'New access token issued' },
          '400': { description: 'Refresh token is required' },
          '403': { description: 'Refresh token is invalid or expired' },
        },
      },
    },
    '/auth/logout': {
      post: {
        tags: ['Auth'],
        summary: 'Logout and invalidate refresh token',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': { description: 'Logged out successfully' },
          '401': { description: 'Authorization required' },
        },
      },
    },
    '/auth/users': {
      get: {
        tags: ['Administration'],
        summary: 'List users for administrator permission management',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': { description: 'Users returned', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/UserSummary' } } } } },
          '401': { description: 'Authorization required' },
          '403': { description: 'Administrator access is required' },
        },
      },
    },
    '/auth/users/{id}/admin': {
      patch: {
        tags: ['Administration'],
        summary: 'Promote or demote a user as administrator',
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/AdminStatusRequest' } } } },
        responses: {
          '200': { description: 'Administrator access updated' },
          '400': { description: 'Cannot remove own administrator access' },
          '403': { description: 'Administrator access is required' },
          '404': { description: 'User not found' },
        },
      },
    },
    '/documents': {
      get: {
        tags: ['Documents'],
        summary: 'Get documents for the authenticated user',
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'page',
            in: 'query',
            schema: { type: 'integer', default: 1 },
          },
          {
            name: 'pageSize',
            in: 'query',
            schema: { type: 'integer', default: 50 },
          },
          {
            name: 'limit',
            in: 'query',
            schema: { type: 'integer', default: 50 },
          },
          {
            name: 'offset',
            in: 'query',
            schema: { type: 'integer', default: 0 },
          },
          {
            name: 'folderId',
            in: 'query',
            schema: { type: 'string' },
          },
          {
            name: 'search',
            in: 'query',
            schema: { type: 'string' },
          },
          {
            name: 'sortBy',
            in: 'query',
            schema: { type: 'string' },
          },
          {
            name: 'order',
            in: 'query',
            schema: { type: 'string', enum: ['asc', 'desc'] },
          },
        ],
        responses: {
          '200': {
            description: 'Documents returned successfully',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/DocumentListResponse' },
              },
            },
          },
          '401': { description: 'Authorization required' },
        },
      },
    },
    '/documents/folders': {
      get: {
        tags: ['Documents'],
        summary: 'Get all saved folders with document counts',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': {
            description: 'Folders returned successfully',
            content: {
              'application/json': {
                schema: {
                  type: 'array',
                  items: { $ref: '#/components/schemas/Folder' },
                },
              },
            },
          },
          '401': { description: 'Authorization required' },
        },
      },
      post: {
        tags: ['Documents'],
        summary: 'Create or update a folder for document grouping',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/CreateFolderRequest' },
            },
          },
        },
        responses: {
          '201': {
            description: 'Folder created or updated successfully',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Folder' },
              },
            },
          },
          '400': { description: 'Missing name or folder_key' },
          '401': { description: 'Authorization required' },
        },
      },
    },
    '/documents/upload': {
      post: {
        tags: ['Documents'],
        summary: 'Upload a single file into a folder',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                properties: {
                  file: { type: 'string', format: 'binary' },
                  title: { type: 'string' },
                  description: { type: 'string' },
                  author: { type: 'string' },
                  folder_id: { type: 'string' },
                  acknowledgement_required: { type: 'boolean', description: 'Require users to review and sign the document.' },
                },
                required: ['file'],
              },
            },
          },
        },
        responses: {
          '201': {
            description: 'File uploaded successfully',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Document' },
              },
            },
          },
          '400': { description: 'File is required' },
          '401': { description: 'Authorization required' },
        },
      },
    },
    '/documents/upload-many': {
      post: {
        tags: ['Documents'],
        summary: 'Upload multiple files into a folder',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                properties: {
                  files: {
                    type: 'array',
                    items: { type: 'string', format: 'binary' },
                  },
                  relativePaths: {
                    type: 'array',
                    items: { type: 'string' },
                  },
                  folder_id: { type: 'string' },
                  acknowledgement_required: { type: 'boolean', description: 'Require users to review and sign each uploaded document.' },
                },
                required: ['files'],
              },
            },
          },
        },
        responses: {
          '201': {
            description: 'Files uploaded successfully',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/UploadManyResponse' },
              },
            },
          },
          '400': { description: 'At least one file is required' },
          '401': { description: 'Authorization required' },
        },
      },
    },
    '/documents/bulk': {
      delete: {
        tags: ['Documents'],
        summary: 'Delete multiple documents by ID',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/DeleteManyRequest' },
            },
          },
        },
        responses: {
          '200': {
            description: 'Documents deleted successfully',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/DeleteManyResponse' },
              },
            },
          },
          '400': { description: 'At least one document id is required' },
          '401': { description: 'Authorization required' },
        },
      },
    },
    '/documents/{id}': {
      get: {
        tags: ['Documents'],
        summary: 'Get a single document metadata record',
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'integer' },
          },
        ],
        responses: {
          '200': {
            description: 'Document returned successfully',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Document' },
              },
            },
          },
          '404': { description: 'Document not found' },
          '401': { description: 'Authorization required' },
        },
      },
      delete: {
        tags: ['Documents'],
        summary: 'Delete a document by ID',
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'integer' },
          },
        ],
        responses: {
          '200': { description: 'Document deleted successfully' },
          '404': { description: 'Document not found' },
          '401': { description: 'Authorization required' },
        },
      },
      patch: {
        tags: ['Documents'],
        summary: 'Update document metadata and acknowledgement requirement',
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: {
            type: 'object', properties: {
              title: { type: 'string' }, description: { type: 'string' }, author: { type: 'string' },
              folder_id: { type: 'string', nullable: true }, acknowledgement_required: { type: 'boolean' },
            },
          } } },
        },
        responses: {
          '200': { description: 'Document updated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Document' } } } },
          '400': { description: 'Title cannot be empty' },
          '401': { description: 'Authorization required' },
          '404': { description: 'Document not found' },
        },
      },
    },
    '/documents/{id}/acknowledge': {
      post: {
        tags: ['Documents'], summary: 'Acknowledge and sign a required document', security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: {
          '200': { description: 'Document signed', content: { 'application/json': { schema: { $ref: '#/components/schemas/Acknowledgement' } } } },
          '400': { description: 'Document does not require acknowledgement' }, '401': { description: 'Authorization required' },
          '404': { description: 'Document not found' },
        },
      },
    },
    '/documents/{id}/acknowledgements': {
      get: {
        tags: ['Administration'], summary: 'List users who signed a document', security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: {
          '200': { description: 'Acknowledgements returned', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Acknowledgement' } } } } },
          '403': { description: 'Administrator access is required' },
        },
      },
    },
    '/documents/{id}/permissions': {
      get: {
        tags: ['Administration'], summary: 'List user permissions for a document', security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: {
          '200': { description: 'Permissions returned', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/DocumentPermission' } } } } },
          '403': { description: 'Administrator access is required' },
        },
      },
    },
    '/documents/{id}/permissions/{userId}': {
      put: {
        tags: ['Administration'], summary: 'Set a user permission record for a document', security: [{ bearerAuth: [] }],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
          { name: 'userId', in: 'path', required: true, schema: { type: 'integer' } },
        ],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/DocumentPermission' } } } },
        responses: {
          '200': { description: 'Permission updated', content: { 'application/json': { schema: { $ref: '#/components/schemas/DocumentPermission' } } } },
          '403': { description: 'Administrator access is required' },
        },
      },
    },
    '/documents/{id}/thumbnail': {
      get: {
        tags: ['Documents'],
        summary: 'Get a document thumbnail image',
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'integer' },
          },
        ],
        responses: {
          '200': { description: 'Thumbnail returned successfully' },
          '404': { description: 'Thumbnail not found' },
          '401': { description: 'Authorization required' },
        },
      },
    },
    '/documents/{id}/download': {
      get: {
        tags: ['Documents'],
        summary: 'Download a document file',
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'integer' },
          },
        ],
        responses: {
          '200': { description: 'Document download stream' },
          '404': { description: 'Document not found' },
          '401': { description: 'Authorization required' },
        },
      },
    },
    '/gallery': {
      get: {
        tags: ['Gallery'],
        summary: 'Get gallery items for the authenticated user',
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'page',
            in: 'query',
            schema: { type: 'integer', default: 1 },
          },
          {
            name: 'pageSize',
            in: 'query',
            schema: { type: 'integer', default: 50 },
          },
          {
            name: 'limit',
            in: 'query',
            schema: { type: 'integer', default: 50 },
          },
          {
            name: 'offset',
            in: 'query',
            schema: { type: 'integer', default: 0 },
          },
          {
            name: 'folderId',
            in: 'query',
            schema: { type: 'string' },
          },
          {
            name: 'search',
            in: 'query',
            schema: { type: 'string' },
          },
          {
            name: 'sortBy',
            in: 'query',
            schema: { type: 'string' },
          },
          {
            name: 'order',
            in: 'query',
            schema: { type: 'string', enum: ['asc', 'desc'] },
          },
        ],
        responses: {
          '200': {
            description: 'Gallery items returned successfully',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/GalleryItemListResponse' },
              },
            },
          },
          '401': { description: 'Authorization required' },
        },
      },
    },
    '/gallery/folders': {
      get: {
        tags: ['Gallery'],
        summary: 'Get gallery folders',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': {
            description: 'Gallery folders returned successfully',
            content: {
              'application/json': {
                schema: {
                  type: 'array',
                  items: { $ref: '#/components/schemas/GalleryFolder' },
                },
              },
            },
          },
          '401': { description: 'Authorization required' },
        },
      },
      post: {
        tags: ['Gallery'],
        summary: 'Create or update a gallery folder',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/CreateGalleryFolderRequest' },
            },
          },
        },
        responses: {
          '201': {
            description: 'Gallery folder created or updated successfully',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/GalleryFolder' },
              },
            },
          },
          '400': { description: 'Missing name or folder_key' },
          '401': { description: 'Authorization required' },
        },
      },
    },
    '/gallery/upload': {
      post: {
        tags: ['Gallery'],
        summary: 'Upload a single gallery item',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                properties: {
                  file: { type: 'string', format: 'binary' },
                  title: { type: 'string' },
                  description: { type: 'string' },
                  folder_id: { type: 'string' },
                },
                required: ['file'],
              },
            },
          },
        },
        responses: {
          '201': {
            description: 'Gallery item uploaded successfully',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/GalleryItem' },
              },
            },
          },
          '400': { description: 'File is required' },
          '401': { description: 'Authorization required' },
        },
      },
    },
    '/gallery/upload-many': {
      post: {
        tags: ['Gallery'],
        summary: 'Upload multiple gallery items',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                properties: {
                  files: {
                    type: 'array',
                    items: { type: 'string', format: 'binary' },
                  },
                  relativePaths: {
                    type: 'array',
                    items: { type: 'string' },
                  },
                  folder_id: { type: 'string' },
                },
                required: ['files'],
              },
            },
          },
        },
        responses: {
          '201': {
            description: 'Gallery items uploaded successfully',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/GalleryUploadManyResponse' },
              },
            },
          },
          '400': { description: 'At least one file is required' },
          '401': { description: 'Authorization required' },
        },
      },
    },
    '/gallery/{id}': {
      get: {
        tags: ['Gallery'],
        summary: 'Get a single gallery item',
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'integer' },
          },
        ],
        responses: {
          '200': {
            description: 'Gallery item returned successfully',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/GalleryItem' },
              },
            },
          },
          '404': { description: 'Gallery item not found' },
          '401': { description: 'Authorization required' },
        },
      },
      delete: {
        tags: ['Gallery'],
        summary: 'Delete a gallery item by ID',
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'integer' },
          },
        ],
        responses: {
          '200': { description: 'Gallery item deleted successfully' },
          '404': { description: 'Gallery item not found' },
          '401': { description: 'Authorization required' },
        },
      },
    },
    '/gallery/{id}/thumbnail': {
      get: {
        tags: ['Gallery'],
        summary: 'Get a gallery item thumbnail image',
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'integer' },
          },
        ],
        responses: {
          '200': { description: 'Thumbnail returned successfully' },
          '404': { description: 'Thumbnail not found' },
          '401': { description: 'Authorization required' },
        },
      },
    },
    '/gallery/{id}/download': {
      get: {
        tags: ['Gallery'],
        summary: 'Download a gallery item file',
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'integer' },
          },
        ],
        responses: {
          '200': { description: 'Gallery item download stream' },
          '404': { description: 'Gallery item not found' },
          '401': { description: 'Authorization required' },
        },
      },
    },
    '/chat/users': {
      get: {
        tags: ['Chat'],
        summary: 'Get all users for starting a new chat',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': { description: 'User directory returned successfully' },
          '401': { description: 'Authorization required' },
        },
      },
    },
    '/chat/conversations': {
      get: {
        tags: ['Chat'],
        summary: 'Get all conversations for the authenticated user',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': { description: 'Conversations returned successfully' },
          '401': { description: 'Authorization required' },
        },
      },
    },
    '/chat/conversations/direct': {
      post: {
        tags: ['Chat'],
        summary: 'Create or open a direct conversation with another user',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['userId'],
                properties: {
                  userId: { type: 'integer' },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Conversation opened successfully' },
          '400': { description: 'Invalid target userId' },
          '401': { description: 'Authorization required' },
          '404': { description: 'User not found' },
        },
      },
    },
    '/chat/conversations/{id}/messages': {
      get: {
        tags: ['Chat'],
        summary: 'Get messages for a conversation',
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'integer' },
          },
          {
            name: 'page',
            in: 'query',
            required: false,
            schema: { type: 'integer', default: 1 },
          },
          {
            name: 'pageSize',
            in: 'query',
            required: false,
            schema: { type: 'integer', default: 30 },
          },
        ],
        responses: {
          '200': { description: 'Messages returned successfully' },
          '401': { description: 'Authorization required' },
          '403': { description: 'Not a participant of this conversation' },
        },
      },
    },
    '/chat/conversations/{id}/read': {
      post: {
        tags: ['Chat'],
        summary: 'Mark all messages in a conversation as read',
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'integer' },
          },
        ],
        responses: {
          '200': { description: 'Conversation marked as read' },
          '401': { description: 'Authorization required' },
          '403': { description: 'Not a participant of this conversation' },
        },
      },
    },
    '/chat/media': {
      get: {
        tags: ['Chat'],
        summary: 'Fetch a chat media file by key',
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'key',
            in: 'query',
            required: true,
            schema: { type: 'string' },
          },
        ],
        responses: {
          '200': { description: 'Media stream returned successfully' },
          '400': { description: 'Invalid media key' },
          '401': { description: 'Authorization required' },
          '404': { description: 'File not found' },
        },
      },
    },
  },
};

module.exports = swaggerDocument;
