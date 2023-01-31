FROM node:16.18.0
COPY . app
WORKDIR /app
RUN npm install
RUN download-akash.sh
CMD ["node","boot"]

# EXPOSE 22