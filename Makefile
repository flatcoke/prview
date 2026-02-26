.PHONY: build run test clean install

BINARY := prview
BUILD_DIR := ./bin

build:
	go build -o $(BUILD_DIR)/$(BINARY) ./cmd/prview

run: build
	$(BUILD_DIR)/$(BINARY)

test:
	go test ./...

clean:
	rm -rf $(BUILD_DIR)

install: build
	cp $(BUILD_DIR)/$(BINARY) $(GOPATH)/bin/$(BINARY) 2>/dev/null || \
	cp $(BUILD_DIR)/$(BINARY) /usr/local/bin/$(BINARY)
